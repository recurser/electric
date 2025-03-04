import { CreateInput, CreateManyInput } from '../input/createInput'
import { FindInput, FindUniqueInput } from '../input/findInput'
import { SyncInput } from '../input/syncInput'
import {
  parseNestedCreate,
  omitCountFromSelectAndIncludeSchema,
  parseNestedUpdate,
  validate,
} from '../validation/validation'
import { UpdateInput, UpdateManyInput } from '../input/updateInput'
import { DeleteInput, DeleteManyInput } from '../input/deleteInput'
import { DatabaseAdapter } from '@electric-sql/drivers'
import { Builder, makeFilter } from './builder'
import { Executor } from '../execution/executor'
import { BatchPayload } from '../output/batchPayload'
import { InvalidArgumentError } from '../validation/errors/invalidArgumentError'
import { _NOT_UNIQUE_, _RECORD_NOT_FOUND_ } from '../validation/errors/messages'
import { UpsertInput } from '../input/upsertInput'
import { SelectSubset } from '../util/types'
import { DB } from '../execution/db'
import { LiveResult, LiveResultContext, Model } from './model'
import { QualifiedTablename } from '../../util/tablename'
import { Notifier } from '../../notifiers'
import { forEach } from '../util/continuationHelpers'
import { Arity, DbSchema, Fields, Relation, TableName } from './schema'
import { HKT, Kind } from '../util/hkt'
import { notNullNotUndefined } from '../util/functions'
import pick from 'lodash.pick'
import omitBy from 'lodash.omitby'
import hasOwn from 'object.hasown'
import * as z from 'zod'
import {
  isPotentiallyDangerous,
  parseTableNames,
  Row,
  Statement,
  createQueryResultSubscribeFunction,
  isObject,
  ReplicatedRowTransformer,
  interpolateSqlArgs,
} from '../../util'
import { NarrowInclude } from '../input/inputNarrowing'
import { IShapeManager } from './shapes'
import { ShapeSubscription } from '../../satellite'
import {
  IReplicationTransformManager,
  setReplicationTransform,
} from './transforms'
import { InputTransformer } from '../conversions/input'
import { Dialect } from '../../migrators/query-builder/builder'
import { computeShape } from './sync'

export type AnyTable = Table<any, any, any, any, any, any, any, any, any, HKT>

export class Table<
  T extends Record<string, any>,
  CreateData extends object,
  UpdateData extends object,
  Select,
  Where extends object | undefined,
  WhereUnique extends object,
  Include extends Record<string, any>,
  OrderBy,
  ScalarFieldEnum,
  GetPayload extends HKT
> implements
    Model<
      T,
      CreateData,
      UpdateData,
      Select,
      Where,
      WhereUnique,
      Include,
      OrderBy,
      ScalarFieldEnum,
      GetPayload
    >
{
  private _builder: Builder
  private _executor: Executor
  private _qualifiedTableName: QualifiedTablename
  private _tables: Map<TableName, AnyTable>
  private _fields: Fields

  private _schema: z.ZodType<Partial<T>>
  private createSchema: z.ZodType<CreateInput<CreateData, Select, Include>>
  private createManySchema: z.ZodType<CreateManyInput<CreateData>>
  private findUniqueSchema: z.ZodType<
    FindUniqueInput<Select, WhereUnique, Include>
  >
  private findSchema: z.ZodType<
    FindInput<Select, Where, Include, OrderBy, ScalarFieldEnum>
  >
  private updateSchema: z.ZodType<
    UpdateInput<UpdateData, Select, WhereUnique, Include>
  >
  private updateManySchema: z.ZodType<UpdateManyInput<UpdateData, Where>>
  private upsertSchema: z.ZodType<
    UpsertInput<CreateData, UpdateData, Select, WhereUnique, Include>
  >
  private deleteSchema: z.ZodType<DeleteInput<Select, WhereUnique, Include>>
  private deleteManySchema: z.ZodType<DeleteManyInput<Where>>
  private syncSchema: z.ZodType<SyncInput<Include, Where>>

  constructor(
    public tableName: string,
    adapter: DatabaseAdapter,
    private _notifier: Notifier,
    private _shapeManager: IShapeManager,
    private _replicationTransformManager: IReplicationTransformManager,
    private _dbDescription: DbSchema<any>,
    private _transformer: InputTransformer,
    public dialect: Dialect
  ) {
    this._fields = this._dbDescription.getFields(tableName)
    const fieldNames = this._dbDescription.getFieldNames(tableName)
    const tableDescription = this._dbDescription.getTableDescription(tableName)
    this._builder = new Builder(
      tableName,
      fieldNames,
      tableDescription,
      this.dialect
    )
    this._executor = new Executor(
      adapter,
      _notifier,
      this._fields,
      this._transformer.converter
    )
    const namespace = this.dialect === 'Postgres' ? 'public' : 'main'
    this._qualifiedTableName = new QualifiedTablename(namespace, tableName)
    this._tables = new Map()
    this._schema = tableDescription.modelSchema
    this.createSchema = omitCountFromSelectAndIncludeSchema(
      tableDescription.createSchema
    )
    this.createManySchema = tableDescription.createManySchema
    this.findUniqueSchema = tableDescription.findUniqueSchema
    this.findSchema = tableDescription.findSchema
    this.updateSchema = omitCountFromSelectAndIncludeSchema(
      tableDescription.updateSchema
    )
    this.updateManySchema = tableDescription.updateManySchema
    this.upsertSchema = tableDescription.upsertSchema
    this.deleteSchema = tableDescription.deleteSchema
    this.deleteManySchema = tableDescription.deleteManySchema

    // TODO: The syncSchema currently allows too much
    //       modify the `where` clause of the schema to allow only the fields
    //       (no nested relation fields)
    //       and also change the field types to expect the value type and no nested filter schema allowed
    this.syncSchema = (tableDescription.findSchema as z.AnyZodObject).pick({
      include: true,
    })
    const shape = (tableDescription.findSchema as z.AnyZodObject).shape.where

    this.syncSchema = (this.syncSchema as any).extend({
      where: shape.or(z.string().optional()),
      key: z.string().optional(),
    })
  }

  setTables(tables: Map<TableName, AnyTable>) {
    this._tables = tables
  }

  protected getIncludedTables<T extends SyncInput<Include, unknown>>(
    i: T
  ): Set<AnyTable> {
    // Recursively go over the included fields
    // and for each field store its table
    const include = i.include ?? {}
    const includedFields = Object.keys(include)
    const includedTables: Set<AnyTable> = new Set([this])
    includedFields.forEach((field: string) => {
      // Fetch the table that is included
      const relatedTableName = this._dbDescription.getRelatedTable(
        this.tableName,
        field
      )
      const relatedTable = this._tables.get(relatedTableName)!
      const extendedTable = includedTables.add(relatedTable)
      // And follow nested includes
      const includedObj = (include as any)[field]
      if (isObject(includedObj)) {
        // There is a nested include, follow it
        const nestedTables = relatedTable.getIncludedTables(includedObj)
        nestedTables.forEach((tbl) => extendedTable.add(tbl))
        return extendedTable
      } else if (typeof includedObj === 'boolean') {
        return extendedTable
      } else {
        throw new Error(
          `Unexpected value in include tree for syncShape: ${JSON.stringify(
            includedObj
          )}`
        )
      }
    })

    return includedTables
  }

  sync<T extends SyncInput<Include, Where>>(i?: T): Promise<ShapeSubscription> {
    const validatedInput = this.syncSchema.parse(i ?? {})
    const shape = computeShape(
      this._dbDescription,
      this.tableName,
      validatedInput
    )
    return this._shapeManager.subscribe([shape], validatedInput.key)
  }

  /*
   * The API is implemented in continuation passing style.
   * Private methods return a function expecting 2 arguments:
   *   1. a transaction
   *   2. a continuation
   * These methods will then execute their query inside the provided transaction and pass the result to the continuation.
   * As such, one can compose these methods arbitrarily and then run them inside a single transaction.
   */

  async create<T extends CreateInput<CreateData, Select, Include>>(
    i: SelectSubset<T, CreateInput<CreateData, Select, Include>>
  ): Promise<Kind<GetPayload, T>> {
    // a higher kinded type GetPayload<T>
    // We have to typecast it because internally when querying the DB we get back a Partial<T>
    // But since we carefully craft the queries we know that only the selected fields are in that object
    return this._executor.transaction((db, cont, onError) =>
      this._create<T>(i, db, cont, onError)
    )
  }

  async createMany<T extends CreateManyInput<CreateData>>(
    i: SelectSubset<T, CreateManyInput<CreateData>>
  ): Promise<BatchPayload> {
    return this._executor.execute(this._createMany.bind(this, i))
  }

  async findUnique<T extends FindUniqueInput<Select, WhereUnique, Include>>(
    i: SelectSubset<T, FindUniqueInput<Select, WhereUnique, Include>>
  ): Promise<Kind<GetPayload, T> | null> {
    return this._executor.execute(
      (db, cont, onError) => this._findUnique(i, db, cont, onError),
      false
    )
  }

  liveUnique<T extends FindUniqueInput<Select, WhereUnique, Include>>(
    i: SelectSubset<T, FindUniqueInput<Select, WhereUnique, Include>>
  ): LiveResultContext<Kind<GetPayload, T> | null> {
    return this.makeLiveResult(() => this.findUnique(i), i)
  }

  async findFirst<
    T extends FindInput<Select, Where, Include, OrderBy, ScalarFieldEnum>
  >(
    i?: SelectSubset<
      T,
      FindInput<Select, Where, Include, OrderBy, ScalarFieldEnum>
    >
  ): Promise<Kind<GetPayload, T> | null> {
    return this._executor.execute(
      (db, cont, onError) => this._findFirst(i, db, cont, onError),
      false
    )
  }

  liveFirst<
    T extends FindInput<Select, Where, Include, OrderBy, ScalarFieldEnum>
  >(
    i?: SelectSubset<
      T,
      FindInput<Select, Where, Include, OrderBy, ScalarFieldEnum>
    >
  ): LiveResultContext<Kind<GetPayload, T> | null> {
    return this.makeLiveResult(() => this.findFirst(i), i ?? {})
  }

  async findMany<
    T extends FindInput<Select, Where, Include, OrderBy, ScalarFieldEnum>
  >(
    i?: SelectSubset<
      T,
      FindInput<Select, Where, Include, OrderBy, ScalarFieldEnum>
    >
  ): Promise<Array<Kind<GetPayload, T>>> {
    return this._executor.execute(
      (db, cont, onError) => this._findMany(i, db, cont, onError),
      false
    )
  }

  liveMany<
    T extends FindInput<Select, Where, Include, OrderBy, ScalarFieldEnum>
  >(
    i?: SelectSubset<
      T,
      FindInput<Select, Where, Include, OrderBy, ScalarFieldEnum>
    >
  ): LiveResultContext<Kind<GetPayload, T>[]> {
    return this.makeLiveResult(() => this.findMany(i), i ?? {})
  }

  async update<T extends UpdateInput<UpdateData, Select, WhereUnique, Include>>(
    i: SelectSubset<T, UpdateInput<UpdateData, Select, WhereUnique, Include>>
  ): Promise<Kind<GetPayload, T>> {
    return this._executor.transaction((db, cont, onError) =>
      this._update(i, db, cont, onError)
    )
  }

  async updateMany<T extends UpdateManyInput<UpdateData, Where>>(
    i: SelectSubset<T, UpdateManyInput<UpdateData, Where>>
  ): Promise<BatchPayload> {
    return this._executor.execute(this._updateMany.bind(this, i))
  }

  async upsert<
    T extends UpsertInput<CreateData, UpdateData, Select, WhereUnique, Include>
  >(
    i: SelectSubset<
      T,
      UpsertInput<CreateData, UpdateData, Select, WhereUnique, Include>
    >
  ): Promise<Kind<GetPayload, T>> {
    return this._executor.transaction((db, cont, onError) =>
      this._upsert(i, db, cont, onError)
    )
  }

  async delete<T extends DeleteInput<Select, WhereUnique, Include>>(
    i: SelectSubset<T, DeleteInput<Select, WhereUnique, Include>>
  ): Promise<Kind<GetPayload, T>> {
    return this._executor.transaction((db, cont, onError) =>
      this._delete(i, db, cont, onError)
    )
  }

  async deleteMany<T extends DeleteManyInput<Where>>(
    i?: SelectSubset<T, DeleteManyInput<Where>>
  ): Promise<BatchPayload> {
    return this._executor.execute(this._deleteMany.bind(this, i))
  }

  private forEachRelation<T extends object>(
    data: T,
    f: (rel: Relation, cont: () => void) => void,
    cont: () => void
  ) {
    const relations = this._dbDescription.getRelations(this.tableName)

    forEach(
      (rel: Relation, cont: () => void) => {
        if (hasOwn(data, rel.relationField)) {
          f(rel, cont)
        } else {
          cont()
        }
      },
      relations,
      cont
    )
  }

  private forEachOutgoingRelation<T extends object>(
    data: T,
    f: (rel: Relation, cont: () => void) => void,
    cont: () => void
  ) {
    this.forEachRelation(
      data,
      (rel, cont) => {
        if (rel.isOutgoingRelation()) {
          f(rel, cont)
        } else {
          cont()
        }
      },
      cont
    )
  }

  protected _create<T extends CreateInput<CreateData, Select, Include>>(
    i: SelectSubset<T, CreateInput<CreateData, Select, Include>>,
    db: DB,
    continuation: (record: Kind<GetPayload, T> & Record<string, any>) => void,
    onError: (err: any) => void
  ) {
    const validatedInput = this._transformer.transformCreate(
      validate(i, this.createSchema),
      this._fields
    )
    const data = validatedInput.data as Record<string, any>

    /*
     * For each outgoing relation with a provided relation field:
     *  - fetch the object in the relation field and recursively create that object
     *  - remember to fill in the FK (i.e. assign the createdObject.toField to fromField in the object we will create)
     *  - remove this relation field from the object we will create
     */

    this.forEachOutgoingRelation(
      data,
      (rel: Relation, cont: () => void) => {
        const { fromField, toField, relationField, relatedTable } = rel
        // fetch the object in the relation field and recursively create that object

        // Return an error if user provided a createMany, connect, connectOrCreate
        // the former will not be supported because you can pass an array of related objects to `create`
        // the latter 2 should eventually be implemented at some point
        const relatedObject = parseNestedCreate(data[relationField]).create

        const relatedTbl = this._tables.get(relatedTable)!
        relatedTbl._create(
          { data: relatedObject },
          db.withTableSchema(relatedTbl._fields),
          (createdRelatedObject) => {
            delete data[relationField] // remove the relation field
            data[fromField] = createdRelatedObject[toField] // fill in the FK
            cont()
          },
          onError
        )
      },
      () => {
        // Once, we created the related objects above,
        // we continue and handle the incoming relations.

        /*
         * For each incoming relation:
         *  - remove the relation field from this object
         *  - remember to create the related object and fill in the `toField` of the object we will create as the FK `fromField` of the related object
         */

        const incomingRelations = this._dbDescription.getIncomingRelations(
          this.tableName
        )

        // below `createRelatedObject` reassigns this variable with a function that wraps this one
        // each wrapper creates an object and calls the wrapped function
        // at the end, the function below will be called which will call the continuation
        let makeRelatedObjects: (obj: object, cont: () => void) => void = (
          _obj,
          cont: () => void
        ) => cont()

        const createRelatedObject = (
          rel: Relation,
          relatedObject: Record<string, any>
        ) => {
          const { relationField, relatedTable, relationName } = rel
          // remove this relation field
          delete data[relationField]
          // create the related object and fill in the FK
          // i.e. fill in the `fromField` on the related object using this object's `toField`
          const oldMakeRelatedObjects = makeRelatedObjects
          makeRelatedObjects = (obj: Record<string, any>, cont: () => void) => {
            const relatedTbl = this._tables.get(relatedTable)!
            // the `fromField` and `toField` are defined on the side of the outgoing relation
            const { fromField, toField } = this._dbDescription.getRelation(
              relatedTable,
              relationName
            )!
            // Create the related object
            relatedObject[fromField] = obj[toField] // fill in FK
            relatedTbl._create(
              { data: relatedObject },
              db.withTableSchema(relatedTbl._fields),
              () => {
                oldMakeRelatedObjects(obj, cont)
              },
              onError
            )
          }
        }

        incomingRelations.forEach((rel: Relation) => {
          const { relationField } = rel
          if (hasOwn(data, relationField)) {
            const relatedObjects = parseNestedCreate(data[relationField]).create
            if (Array.isArray(relatedObjects)) {
              // this is a one-to-many relation
              // create all the related objects
              relatedObjects.forEach(createRelatedObject.bind(this, rel))
            } else {
              // this is a one-to-one relation
              // create the related object
              createRelatedObject(rel, relatedObjects)
            }
          }
        })

        /*
         * Now create the object and then:
         *  - create the related objects for the incoming relations
         */

        // Make a SQL query out of the parsed data
        const createQuery = this._builder.create({
          ...validatedInput,
          data: data,
        })

        db.query(
          createQuery,
          this._schema,
          (db, insertedObjects) => {
            if (insertedObjects.length !== 1)
              onError('Wrong amount of objects were created.')

            // Now, create the related objects
            const insertedObject = insertedObjects[0]
            makeRelatedObjects(insertedObject, () => {
              // Now read the record that was inserted
              // need to read it because some fields could be auto-generated
              // it would be enough to select on a unique ID, but we don't know which field(s) is the unique ID
              // hence, for now `findCreated` filters on all the values that are provided in `validatedInput.data`
              this._findUniqueWithoutAutoSelect(
                {
                  where: data,
                  select: validatedInput.select,
                  ...(notNullNotUndefined(validatedInput.include) && {
                    include: validatedInput.include,
                  }), // only add `include` property if it is defined
                } as any,
                db,
                continuation as any,
                onError,
                'Create'
              )
            })
          },
          onError
        )
      }
    )
  }

  private _createMany<T extends CreateManyInput<CreateData>>(
    i: SelectSubset<T, CreateManyInput<CreateData>>,
    db: DB,
    continuation: (res: BatchPayload) => void,
    onError: (err: any) => void
  ) {
    const data = this._transformer.transformCreateMany(
      validate(i, this.createManySchema),
      this._fields
    )
    const sql = this._builder.createMany(data)
    db.run(
      sql,
      (_, { rowsAffected }) => {
        continuation({ count: rowsAffected })
      },
      onError
    )
  }

  private _findUnique<T extends FindUniqueInput<Select, WhereUnique, Include>>(
    i: SelectSubset<T, FindUniqueInput<Select, WhereUnique, Include>>,
    db: DB,
    continuation: (res: Kind<GetPayload, T> | null) => void,
    onError: (err: any) => void
  ) {
    const data = this._transformer.transformFindUnique(
      validate(i, this.findUniqueSchema),
      this._fields
    )
    const sql = this._builder.findUnique(data)
    db.query(
      sql,
      this._schema,
      (_, res) => {
        if (res.length > 1) throw new InvalidArgumentError(_NOT_UNIQUE_)
        if (res.length === 1)
          return this.fetchIncludes(
            res as any,
            data.include,
            db,
            (rows) => {
              continuation(rows[0] as any)
            },
            onError
          )
        return continuation(null)
      },
      onError
    )
  }

  private _findFirst<
    T extends FindInput<Select, Where, Include, OrderBy, ScalarFieldEnum>
  >(
    i:
      | SelectSubset<
          T,
          FindInput<Select, Where, Include, OrderBy, ScalarFieldEnum>
        >
      | undefined,
    db: DB,
    continuation: (res: Kind<GetPayload, T> | null) => void,
    onError: (err: any) => void
  ) {
    const data = this._transformer.transformFindNonUnique(
      validate(i ?? {}, this.findSchema),
      this._fields
    )
    const sql = this._builder.findFirst(data)
    db.query(
      sql,
      this._schema,
      (_, res) => {
        if (res.length === 0) return continuation(null)
        return this.fetchIncludes(
          [res[0]] as any,
          (data as any).include,
          db,
          (rows) => {
            continuation(rows[0] as any)
          },
          onError
        )
      },
      onError
    )
  }

  /**
   * Joins objects in `rows` with objects in `relatedRows` where `row.fromField === relatedRow.toField`.
   * Beware: this function mutates the objects in `rows`.
   * @param rows Array of original objects
   * @param relatedRows Array of related objects
   * @param fromField Field of objects in `rows` that points to related object.
   * @param toField Field of objects in `relatedRows` that is pointed at by the original object.
   */
  private joinObjects(
    rows: Array<Record<string, any>>,
    relatedRows: Array<Record<string, any>>,
    fromField: string,
    toField: string,
    relationField: string,
    relationArity: Arity
  ) {
    return rows.map((row) => {
      const relatedObjects = relatedRows.filter(
        (r) => row[fromField] === r[toField]
      )
      if (relatedObjects.length === 0) return row
      else if (relationArity === 'one') {
        if (relatedObjects.length > 1)
          throw TypeError(
            `Relation on field '${relationField}' is one-to-one but found several related objects: ` +
              JSON.stringify(relatedObjects)
          )
        // one-to-one or one-to-many relation and we fetched the related object on the one side.
        // so we assign the related object to `relationField`
        const [relatedObject] = relatedObjects
        return Object.assign(row, {
          [relationField]: relatedObject,
        })
      } else {
        // one-to-many relation and we fetched the related objects on the many side
        // so we assign the array of related objects to `relationField`
        return Object.assign(row, {
          [relationField]: relatedObjects,
        })
      }
    })
  }

  private fetchRelated(
    rows: Kind<GetPayload, T>[],
    relatedTable: string,
    fromField: string,
    toField: string,
    relationField: string,
    relationType: Arity,
    includeArg: true | FindInput<any, any, any, any, any>,
    db: DB,
    onResult: () => void,
    onError: (err: any) => void
  ) {
    const otherTable = this._tables.get(relatedTable)!
    const args = includeArg === true ? {} : includeArg
    const where = typeof args.where === 'undefined' ? {} : args.where
    const foreignKeys = rows
      .map((row) => row[fromField as keyof typeof row])
      .filter((fk) => fk !== null && fk !== undefined)
    otherTable._findMany(
      {
        ...args,
        where: {
          ...where,
          [toField]: {
            in: foreignKeys,
          },
        },
      },
      db.withTableSchema(otherTable._fields),
      (relatedRows: object[]) => {
        // Now, join the original `rows` with the `relatedRows`
        // where `row.fromField == relatedRow.toField`
        // (this mutates the original rows)
        this.joinObjects(
          rows,
          relatedRows,
          fromField,
          toField,
          relationField,
          relationType
        ) as Kind<GetPayload, T>[]
        onResult()
      },
      onError
    )
  }

  private fetchInclude(
    rows: Kind<GetPayload, T>[],
    relation: Relation,
    includeArg: boolean | FindInput<any, any, any, any, any>,
    db: DB,
    onResult: () => void,
    onError: (err: any) => void
  ) {
    if (includeArg === false) {
      return onResult()
    } else if (relation.isIncomingRelation()) {
      // incoming relation from the `fromField` in the other table
      // to the `toField` in this table
      const { fromField, toField } = relation.getOppositeRelation(
        this._dbDescription
      )
      // The `fromField` and `toField` are defined
      // from the perspective of the outgoing relation
      // (`fromField` being in the table and `toField` being in the related table).
      // Fetch the related object like for an outgoing relation
      // but switch the `toField` and `fromField` fields because
      // `toField` is defined in this table and `fromField` is defined in the related table.
      this.fetchRelated(
        rows,
        relation.relatedTable,
        toField,
        fromField,
        relation.relationField,
        relation.relatedObjects,
        includeArg,
        db,
        onResult,
        onError
      )
    } else {
      // outgoing relation from the `fromField` in this table
      // to the `toField` in `relatedTable`
      const {
        fromField,
        toField,
        relationField,
        relatedObjects,
        relatedTable,
      } = relation
      this.fetchRelated(
        rows,
        relatedTable,
        fromField,
        toField,
        relationField,
        relatedObjects,
        includeArg,
        db,
        onResult,
        onError
      )
    }
  }

  private fetchIncludes(
    rows: Kind<GetPayload, T>[],
    include: NarrowInclude<Include> | undefined,
    db: DB,
    onResult: (res: Kind<GetPayload, T>[]) => void,
    onError: (err: any) => void
  ) {
    if (typeof include === 'undefined' || rows.length === 0)
      return onResult(rows)
    else {
      const relationFields = Object.keys(include)
      forEach(
        (relationField: string, cont: () => void) => {
          if (
            !this._dbDescription.hasRelationForField(
              this.tableName,
              relationField
            )
          ) {
            throw new InvalidArgumentError(
              'Unexpected field `' + relationField + '` in `include` argument.'
            )
          }

          const relationName = this._dbDescription.getRelationName(
            this.tableName,
            relationField
          )!
          const relation = this._dbDescription.getRelation(
            this.tableName,
            relationName
          )

          // `fetchInclude` mutates the `rows` to include the related objects
          this.fetchInclude(
            rows,
            relation,
            include[relationField],
            db,
            cont,
            onError
          )
        },
        relationFields,
        () => {
          // once the loop finished, call `onResult`
          onResult(rows)
        }
      )
    }
  }

  private _findMany<
    T extends FindInput<Select, Where, Include, OrderBy, ScalarFieldEnum>
  >(
    i:
      | SelectSubset<
          T,
          FindInput<Select, Where, Include, OrderBy, ScalarFieldEnum>
        >
      | undefined,
    db: DB,
    continuation: (res: Kind<GetPayload, T>[]) => void,
    onError: (err: any) => void
  ) {
    const data = this._transformer.transformFindNonUnique(
      validate(i ?? {}, this.findSchema),
      this._fields
    )
    const sql = this._builder.findMany(data)
    db.query(
      sql,
      this._schema,
      (_, rows) => {
        this.fetchIncludes(
          rows as any,
          (data as any).include,
          db,
          continuation as any,
          onError
        )
      },
      onError
    )
  }

  private _findUniqueWithoutAutoSelect<
    T extends FindUniqueInput<Select, WhereUnique, Include>
  >(
    i: SelectSubset<T, FindUniqueInput<Select, WhereUnique, Include>>,
    db: DB,
    continuation: (res: Kind<GetPayload, T> & Record<string, any>) => void,
    onError: (err: any) => void,
    queryType: string
  ) {
    const q = this._builder.findWithoutAutoSelect(i)
    db.query(
      q,
      this._schema,
      (_, rows) => {
        if (rows.length === 0)
          throw new InvalidArgumentError(_RECORD_NOT_FOUND_(queryType))
        if (rows.length > 1) throw new InvalidArgumentError(_NOT_UNIQUE_)

        // Fetch the related objects requested by the `include` argument
        this.fetchIncludes(
          rows as any,
          i.include,
          db,
          (joinedRows) => {
            const [joinedObj] = joinedRows
            continuation(joinedObj as any)
          },
          onError
        )
      },
      onError
    )
  }

  /**
   * Updates the related object of a one-to-one relation (when `updateType === 'update'`)
   * or many related objects from a one-to-many relation (when `updateType === 'updateMany'`).
   * The related object(s) is one or more rows from the `relatedTable` that matches the `obj.where` argument
   * and where the value of `toField` equals `fromFieldValue`.
   */
  private updateRelatedObject(
    obj: { where?: object; data: object } | undefined,
    relatedTable: string,
    fromFieldValue: any,
    toField: string,
    isIncomingRelation: boolean,
    db: DB,
    cont: (updatedObj?: Record<string, any>) => void,
    onError: (err: any) => void,
    updateType: 'update' | 'updateMany' = 'update'
  ) {
    if (typeof obj === 'undefined') {
      cont()
    } else {
      const relatedTbl = this._tables.get(relatedTable)!

      if (updateType === 'update') {
        // for incoming relations there is no need to match on `toField`
        // because the `where` argument of the nested update already uniquely identifies the object
        const whereArg = isIncomingRelation
          ? obj.where
          : {
              ...obj.where,
              [toField]: fromFieldValue,
            }

        relatedTbl._update(
          {
            data: obj.data,
            where: whereArg,
          },
          db.withTableSchema(relatedTbl._fields),
          cont,
          onError
        )
      } else {
        relatedTbl._updateMany(
          {
            data: obj.data,
            where: {
              ...obj.where,
              // `obj.where` might not be enough to identify only the objects that are related
              //  so restrict the object to only those that are related by this foreign key
              [toField]: fromFieldValue,
            },
          },
          db.withTableSchema(relatedTbl._fields),
          cont,
          onError
        )
      }
    }
  }

  /**
   * Takes the original object and the updated object
   * and updates foreign keys of related objects
   * that were pointing at a field that got updated.
   * @param cont Function to call after the foreign keys are updated.
   */
  private updateFKs(
    originalObject: Kind<
      GetPayload,
      FindUniqueInput<Select, WhereUnique, Include>
    >,
    updatedObj: Kind<GetPayload, FindUniqueInput<Select, WhereUnique, Include>>,
    db: DB,
    onError: (err: any) => void,
    cont: () => void
  ) {
    /*
     * Compute a diff containing all fields that were updated.
     * For each updated field check if there are relations pointing to that field.
     * For each relation pointing to that field, update that pointer such that it points to the new value.
     */
    const diff = omitBy(updatedObj, (value, field) => {
      return originalObject[field] === value
    })

    const updatedFields = Object.keys(diff)
    // Keep only the updated fields that are pointed at by at least one relation
    const updatedIncomingFields = updatedFields.filter((field) => {
      return (
        this._dbDescription.getRelationsPointingAtField(this.tableName, field)
          .length > 0
      )
    })

    forEach(
      (toField, cont) => {
        // Update each relation pointing to this field
        const incomingRelations =
          this._dbDescription.getRelationsPointingAtField(
            this.tableName,
            toField
          )
        forEach(
          (relation, cont) => {
            // Fetch the `fromField` and `toField` of the relation
            // This is defined on the outgoing side of the relation
            const relatedTableName = relation.relatedTable
            const { fromField } = relation.getOppositeRelation(
              this._dbDescription
            )
            const relatedTable = this._tables.get(relatedTableName)!
            relatedTable._updateMany(
              {
                data: {
                  [fromField]: updatedObj[toField],
                },
                where: {
                  [fromField]: originalObject[toField],
                },
              },
              db.withTableSchema(relatedTable._fields),
              cont,
              onError
            )
          },
          incomingRelations,
          cont
        )
      },
      updatedIncomingFields,
      cont
    )
  }

  /**
   * Updates related objects for incoming relations based on
   * nested `updateMany` argument that is provided with `update`.
   *
   * @example
   * The example below updates the title of all posts written by `user1`.
   * In the `User` table there is an incoming relation from each post to the user that wrote it.
   * This method updates all related objects for such an incoming relation:
   * ```
   * User.update({
   *   data: {
   *     posts: {
   *       updateMany: {
   *         data: {
   *           title: 'A new title for all my posts'
   *         },
   *         where: {}
   *       }
   *     }
   *   },
   *   where: {
   *     id: user1.id
   *   }
   * })
   * ```
   *
   * @param relatedTable The name of the table containing the related objects.
   * @param relationName The name of the relation between the two tables.
   * @param ogObject The object on which `update` is called, before the update is executed.
   * @param updateManyObject The object that was passed as `updateMany` argument to `update`.
   * @param onError Error handler callback.
   * @param cont Function that will be called once the related objects are updated.
   */
  private updateManyRelatedObjectsFromIncomingRelation(
    relatedTable: string,
    relationName: string,
    ogObject: Record<string, any>,
    updateManyObject: object | undefined | any[],
    db: DB,
    onError: (err: any) => void,
    cont: () => void
  ) {
    // incoming relation, can be one-to-one or one-to-many

    // the `fromField` and `toField` are defined from the perspective of the outgoing relation
    // update the related object like for an outgoing relation but switch the `to` and `from` fields
    const { fromField, toField } = this._dbDescription.getRelation(
      relatedTable,
      relationName
    )!
    const toFieldValue = ogObject[toField]

    // User may optionally provide an `updateMany` field containing an object or an array of objects
    // if it is an object we wrap it in an array and then process the array of objects
    const updateManyArray = Array.isArray(updateManyObject)
      ? updateManyObject
      : typeof updateManyObject === 'undefined'
      ? []
      : [updateManyObject]

    // update all the requested related objects
    forEach(
      (updateObj, cont) => {
        this.updateRelatedObject(
          updateObj,
          relatedTable,
          toFieldValue,
          fromField,
          true,
          db,
          cont,
          onError,
          'updateMany'
        )
      },
      updateManyArray,
      cont
    )
  }

  /**
   * Updates related objects for incoming relations based on
   * nested `update` argument that is provided with `update`.
   * For example:
   *  User.update({
   *    data: {
   *      posts: {
   *        update: {
   *          data: {
   *            title: 'A new title for all my posts'
   *          },
   *          where: {
   *            id: post2.id
   *          }
   *        }
   *      }
   *    },
   *    where: {
   *      id: user1.id
   *    }
   *  })
   * The above example updates the title of post2 that was written by `user1`.
   * This method updates that related object for such incoming relations.
   *
   * @param relatedTable The name of the table containing the related objects.
   * @param relationName The name of the relation between the two tables.
   * @param ogObject The object on which `update` is called, before the update is executed.
   * @param updateObject The object that was passed as nested `update` argument to `update`.
   * @param onError Error handler callback.
   * @param cont Function that will be called once the related objects are updated.
   */
  private updateRelatedObjectFromIncomingRelation(
    relatedTable: string,
    relationName: string,
    ogObject: Record<string, any>,
    updateObject: object | undefined | any[],
    db: DB,
    onError: (err: any) => void,
    cont: () => void
  ) {
    // incoming relation, can be one-to-one or one-to-many
    const { relatedObjects } = this._dbDescription.getRelation(
      this.tableName,
      relationName
    )!

    // the `fromField` and `toField` are defined on the side of the outgoing relation
    // update the related object like for an outgoing relation but switch the `to` and `from` fields
    const { fromField, toField } = this._dbDescription.getRelation(
      relatedTable,
      relationName
    )!
    const toFieldValue = ogObject[toField]

    if (relatedObjects === 'many') {
      // this is a one-to-many relation
      // update all the requested related objects

      // `updateObj` may be an array of objects or a single object
      // if it is a single object we wrap it in an array and then process the array
      const updateObjects = Array.isArray(updateObject)
        ? updateObject
        : typeof updateObject === 'undefined'
        ? []
        : [updateObject]

      forEach(
        (updateObj, cont) => {
          this.updateRelatedObject(
            updateObj,
            relatedTable,
            toFieldValue,
            fromField,
            true,
            db,
            (res) => {
              // the `where` argument of the nested update uniquely identifies the object
              // and is used to update the related object.
              // However, we need to make sure that the object
              // that is identified by `where` is indeed a related object!
              const updatedObj = res as Record<string, any>
              if (updatedObj[fromField] !== toFieldValue) {
                // the object is not related to the object of the original `update` query
                throw new InvalidArgumentError(
                  `Nested update cannot update an unrelated object.\n` +
                    `Related object has field ${fromField} === ${toFieldValue}\n` +
                    `but the object identified by ${JSON.stringify(
                      updateObj
                    )} has ${fromField} === ${updatedObj[fromField]}`
                )
              }
              cont()
            },
            onError
          )
        },
        updateObjects,
        cont
      )
    } else {
      // this is a one-to-one relation
      // update the related object
      const typedUpdateObj =
        typeof updateObject === 'undefined'
          ? undefined
          : { data: updateObject, where: { [toField]: toFieldValue } }

      this.updateRelatedObject(
        typedUpdateObj,
        relatedTable,
        toFieldValue,
        fromField,
        true,
        db,
        cont,
        onError
      )
    }
  }

  private updateRelatedObjectFromOutgoingRelation(
    relation: Relation,
    ogObject: Record<string, any>,
    updateObject: object | undefined,
    relatedTable: string,
    db: DB,
    cont: (updatedObj: Record<string, any> | undefined) => void,
    onError: (err: any) => void
  ) {
    // outgoing relation
    const { fromField, toField } = relation
    const fromFieldValue = ogObject[fromField]

    // update the related object
    const wrappedUpdateObject =
      typeof updateObject === 'undefined' ? undefined : { data: updateObject }

    this.updateRelatedObject(
      wrappedUpdateObject,
      relatedTable,
      fromFieldValue,
      toField,
      false,
      db,
      cont,
      onError
    )
  }

  private _update<
    T extends UpdateInput<UpdateData, Select, WhereUnique, Include>
  >(
    i: SelectSubset<T, UpdateInput<UpdateData, Select, WhereUnique, Include>>,
    db: DB,
    continuation: (res: Kind<GetPayload, T>) => void,
    onError: (err: any) => void
  ) {
    const data = this._transformer.transformUpdate(
      validate(i, this.updateSchema),
      this._fields
    )

    // Find the record and make sure it is unique
    this._findUnique(
      { where: data.where } as any,
      db,
      (originalObject) => {
        const ogObject = originalObject as Record<string, any>
        if (originalObject === null)
          throw new InvalidArgumentError(_RECORD_NOT_FOUND_('Update'))

        // We will update the record we found but
        // we need to remove all relation fields from `data.data`
        // because they don't exist on this table
        // and those related object(s) will be updated afterwards
        const fields = this._dbDescription.getFieldNames(this.tableName)
        const nonRelationalData: Record<string, any> = pick(data.data, fields)
        const nonRelationalFields: string[] = Object.keys(nonRelationalData)
        const nonRelationalObject = {
          ...data,
          data: nonRelationalData,
        }

        const updateRelatedObjects = (db: DB, res: unknown[]) => {
          const updatedObj = res[0] as typeof originalObject
          // Some objects may be pointing to `originalObject`
          // but the value they were pointing at may have changed
          // so we need to update those FKs correspondingly
          this.updateFKs(originalObject, updatedObj, db, onError, () => {
            // Also update any related objects that are provided in the query
            this.updateRelatedObjects(
              data as unknown as UpdateInput<
                UpdateData,
                Select,
                WhereUnique,
                Include
              >,
              ogObject,
              db,
              nonRelationalData,
              onError,
              continuation
            )
          })
        }

        if (nonRelationalFields.length > 0) {
          // Update the record
          const updateDataQuery = this._builder.update(nonRelationalObject)
          db.query(updateDataQuery, this._schema, updateRelatedObjects, onError)
        } else {
          // Nothing to update for this record
          // but we may have to update related records
          updateRelatedObjects(db, [ogObject])
        }
      },
      onError
    )
  }

  /**
   * Updates may also include nested updates to related objects.
   * This function updates those related objects as requested by the user.
   */
  private updateRelatedObjects<
    T extends UpdateInput<UpdateData, Select, WhereUnique, Include>
  >(
    data: UpdateInput<UpdateData, Select, WhereUnique, Include>,
    ogObject: Record<string, any>,
    db: DB,
    nonRelationalData: Record<string, any>,
    onError: (err: any) => void,
    continuation: (res: Kind<GetPayload, T>) => void
  ) {
    /*
     * For each outgoing FK relation:
     *  - update the related object
     *  - add the fromField (i.e. outgoing FK) to `nonRelationalData`
     *    because we will fetch the updated object based on its new values
     *    and that field may have changed
     */
    this.forEachRelation(
      data.data as object,
      (rel: Relation, cont: () => void) => {
        const { relationField, relatedTable, relationName } = rel
        const dataRecord = data.data as Record<string, any>

        // fetch the related object and recursively update that object
        const relationActions = parseNestedUpdate(dataRecord[relationField])
        const updateObject = relationActions.update

        if (rel.isOutgoingRelation()) {
          this.updateRelatedObjectFromOutgoingRelation(
            rel,
            ogObject,
            updateObject,
            relatedTable,
            db,
            (updatedObj) => {
              // The update might have changed the value of `toField` that this `fromField` is pointing to
              // That update will then have modified our `fromField` to point to the modified `toField`
              const updatedObject = updatedObj!
              const toFieldValue = updatedObject[rel.toField]

              // Add the new value of the `fromField` to `nonRelationalData`
              // such that we keep it into account when fetching the updated record
              nonRelationalData[rel.fromField] = toFieldValue
              cont()
            },
            onError
          )
        } else {
          // incoming relation, can be one-to-one or one-to-many
          this.updateRelatedObjectFromIncomingRelation(
            relatedTable,
            relationName,
            ogObject,
            updateObject,
            db,
            onError,
            () => {
              // Now also handle nested `updateMany` argument
              // `updateMany` argument can only be provided on an incoming one-to-many relation
              const updateManyObject = relationActions.updateMany
              this.updateManyRelatedObjectsFromIncomingRelation(
                relatedTable,
                relationName,
                ogObject,
                updateManyObject,
                db,
                onError,
                cont
              )
            }
          )
        }
      },
      () => {
        // Fetch the updated record
        this._findUniqueWithoutAutoSelect(
          {
            where: { ...data.where, ...nonRelationalData },
            select: data.select,
            ...(notNullNotUndefined(data.include) && {
              include: data.include,
            }), // only add `include` property if it is defined
          } as any,
          db,
          continuation,
          onError,
          'Update'
        )
      }
    )
  }

  private _updateMany<T extends UpdateManyInput<UpdateData, Where>>(
    i: SelectSubset<T, UpdateManyInput<UpdateData, Where>>,
    db: DB,
    continuation: (res: BatchPayload) => void,
    onError: (err: any) => void
  ) {
    const data = this._transformer.transformUpdateMany(
      validate(i, this.updateManySchema),
      this._fields
    )
    const sql = this._builder.updateMany(data)
    db.run(
      sql,
      (_, { rowsAffected }) => {
        return continuation({ count: rowsAffected })
      },
      onError
    )
  }

  private _upsert<
    T extends UpsertInput<CreateData, UpdateData, Select, WhereUnique, Include>
  >(
    i: SelectSubset<
      T,
      UpsertInput<CreateData, UpdateData, Select, WhereUnique, Include>
    >,
    db: DB,
    continuation: (res: Kind<GetPayload, T>) => void,
    onError: (err: any) => void
  ) {
    // validate but do not transform - upsert will call either
    // create or update that will perform the appropriate transforms
    validate(i, this.upsertSchema)

    // Check if the record exists
    this._findUnique(
      { where: i.where } as any,
      db,
      (rows) => {
        if (rows === null) {
          // Create the record
          return this._create(
            {
              data: i.create,
              select: i.select,
              ...(notNullNotUndefined(i.include) && {
                include: i.include,
              }), // only add `include` property if it is defined
            } as any,
            db,
            continuation as any,
            onError
          )
        } else {
          // Update the record
          return this._update(
            {
              data: i.update,
              where: i.where,
              select: i.select,
              ...(notNullNotUndefined(i.include) && {
                include: i.include,
              }), // only add `include` property if it is defined
            } as any,
            db,
            continuation as any,
            onError
          )
        }
      },
      onError
    )
  }

  private _delete<T extends DeleteInput<Select, WhereUnique, Include>>(
    i: SelectSubset<T, DeleteInput<Select, WhereUnique, Include>>,
    db: DB,
    continuation: (res: Kind<GetPayload, T>) => void,
    onError: (err: any) => void
  ) {
    const data = this._transformer.transformDelete(
      validate(i, this.deleteSchema),
      this._fields
    )
    // Check that the record exists
    this._findUniqueWithoutAutoSelect(
      data as any,
      db,
      (record) => {
        // Delete it and return the deleted record
        const deleteQuery = this._builder.delete(data)
        db.run(
          deleteQuery,
          () => continuation(record as Kind<GetPayload, T>),
          onError
        )
      },
      onError,
      'Delete'
    )
  }

  private _deleteMany<T extends DeleteManyInput<Where>>(
    i: SelectSubset<T, DeleteManyInput<Where>> | undefined,
    db: DB,
    continuation: (res: BatchPayload) => void,
    onError: (err: any) => void
  ) {
    const data = this._transformer.transformDeleteMany(
      validate(i ?? {}, this.deleteManySchema),
      this._fields
    )
    const sql = this._builder.deleteMany(data)
    db.run(
      sql,
      (_, { rowsAffected }) => {
        continuation({ count: rowsAffected })
      },
      onError
    )
  }

  private makeLiveResult<T>(
    runner: () => Promise<T>,
    i: SyncInput<Include, unknown>
  ): LiveResultContext<T> {
    const tables = [...this.getIncludedTables(i)].map(
      (x) => x._qualifiedTableName
    )

    const result = <LiveResultContext<T>>(() => {
      return runner().then((res) => {
        return new LiveResult(res, tables)
      })
    })

    result.subscribe = createQueryResultSubscribeFunction(
      this._notifier,
      result,
      tables
    )
    result.sourceQuery = i
    return result
  }

  setReplicationTransform(i: ReplicatedRowTransformer<T>): void {
    setReplicationTransform<T>(
      this._dbDescription,
      this._replicationTransformManager,
      this._qualifiedTableName,
      i,
      this._schema
    )
  }

  clearReplicationTransform(): void {
    this._replicationTransformManager.clearTableTransform(
      this._qualifiedTableName
    )
  }
}

export function unsafeExec(
  adapter: DatabaseAdapter,
  sql: Statement
): Promise<Row[]> {
  return adapter.query(sql)
}

export function rawQuery(
  adapter: DatabaseAdapter,
  sql: Statement
): Promise<Row[]> {
  // only allow safe queries from the client
  if (isPotentiallyDangerous(sql.sql)) {
    throw new InvalidArgumentError(
      'Cannot use queries that might alter the store - please use read-only queries'
    )
  }

  return unsafeExec(adapter, sql)
}

export function liveRawQuery(
  adapter: DatabaseAdapter,
  notifier: Notifier,
  sql: Statement
): LiveResultContext<Row[]> {
  const result = <LiveResultContext<Row[]>>(async () => {
    // parse the table names from the query
    // because this is a raw query so
    // we cannot trust that it queries this table
    const tablenames = parseTableNames(sql.sql, adapter.defaultNamespace)
    const res = await rawQuery(adapter, sql)
    return new LiveResult(res, tablenames)
  })

  result.subscribe = createQueryResultSubscribeFunction(
    notifier,
    result,
    parseTableNames(sql.sql, adapter.defaultNamespace)
  )
  result.sourceQuery = sql
  return result
}

/** Compile Prisma-like where-clause object into a SQL where clause that the server can understand. */
export function makeSqlWhereClause(
  where: string | Record<string, any>
): string {
  if (typeof where === 'string') return where

  const statements = Object.entries(where)
    .flatMap(([key, value]) => makeFilter(value, key, 'this.'))
    .map(interpolateSqlArgsForPostgres)

  if (statements.length < 2) return statements[0] ?? ''
  else return statements.map((x) => '(' + x + ')').join(' AND ')
}

/** Interpolate SQL arguments into a string that PostgreSQL can understand. */
function interpolateSqlArgsForPostgres({
  sql,
  args,
}: {
  sql: string
  args?: unknown[]
}) {
  return interpolateSqlArgs({ sql, args: args?.map(quoteValueForPostgres) })
}

/** Quote a JS value to be inserted in a PostgreSQL where query for the server. */
function quoteValueForPostgres(value: unknown): string {
  if (typeof value === 'string') return `'${value.replaceAll("'", "''")}'`
  if (typeof value === 'number') return value.toString()
  if (value instanceof Date && !isNaN(value.valueOf()))
    return `'${value.toISOString()}'`
  if (typeof value === 'boolean') return value.toString()
  if (Array.isArray(value))
    return `(${value.map(quoteValueForPostgres).join(', ')})`

  throw new Error(
    `Sorry! We currently cannot handle where clauses using value ${value}. You can try serializing it to a string yourself. \nPlease leave a feature request at https://github.com/electric-sql/electric/issues.`
  )
}
