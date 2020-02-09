import { Promise } from "bluebird";
import { Entity, EntityState, EntityType, KeyMapping, MetadataStore, SaveOptions } from "breeze-client";
import * as _ from 'lodash';
import { SaveMap } from "./SaveMap";
import { Model, Transaction } from "sequelize";
import { KeyGenerator, SequelizeManager } from "./SequelizeManager";
let toposort = require("toposort") as (ar: any[]) => any[];

export type OpenObj = {[k: string]: any}; 

export type ServerEntityState =  "Added" | "Deleted" | "Modified";

/** Save bundle from breeze client */
export interface SaveRequest {
  body: { entities: ServerEntity[], saveOptions?: SaveOptions }
}

export interface ServerEntity {
  [k: string]: any;   // entity values
  entityAspect: ServerEntityAspect;
}

/** Server-side representation of entity that came from the client */
export interface ServerEntityInfo {
  entity: ServerEntity;
  entityType: EntityType;
  wasAddedOnServer?: boolean;
  forceUpdate?: boolean;
  unmapped?: any;
  entityAspect: ServerEntityAspect;
}

export interface ServerEntityAspect {
  entityTypeName: string;
  defaultResourceName: string,
  entityState: ServerEntityState;
  entity?: ServerEntity;
  autoGeneratedKey?: {
    autoGeneratedKeyType: string;
    propertyName?: string;
  }
  originalValuesMap?: { [prop: string]: any };
}

/** Validation error created on the server */
export interface ServerEntityError {
  entityTypeName: string;
  errorName: string;
  errorMessage: string;
  propertyName: string;
  keyValues: any[];
}

interface ServerEntityGroup {
  entityType: EntityType;
  entityInfos: ServerEntityInfo[];
}

export interface SequelizeSaveError {
  errors: ServerEntityError[];
  message: string;
}

type SequelizeRawSaveResult = Entity[] | SequelizeSaveError;

export interface SequelizeSaveResult {
  entities: Entity[];
  keyMappings: KeyMapping[];
}

export type BeforeSaveEntityFn = (e: ServerEntityInfo) => boolean;

export type BeforeSaveEntitiesFn = (sm: SaveMap, trx?: Transaction) => SaveMap;


/** Handles saving entities from Breeze SaveChanges requests */
export class SequelizeSaveHandler {
  readonly sequelizeManager: SequelizeManager;
  readonly metadataStore: MetadataStore;
  readonly entitiesFromClient: ServerEntity[];
  saveOptions: SaveOptions;
  private _keyMappings: KeyMapping[];
  private _fkFixupMap: { [entityKeyName: string]: any };
  private _savedEntities: OpenObj[];
  /** Generates keys for entity types where autoGeneratedKeyType = "KeyGenerator" */
  keyGenerator: KeyGenerator;
  /** Process an entity before save. If false is returned, entity is not saved. */
  beforeSaveEntity: BeforeSaveEntityFn
  /** Process all entities before save.  The entities in the returned SaveMap are saved. */
  beforeSaveEntities: BeforeSaveEntitiesFn

  /** Create an instance for the given save request */
  constructor(sequelizeManager: SequelizeManager, req: SaveRequest) {
    let reqBody = req.body;
    this.sequelizeManager = sequelizeManager;
    this.metadataStore = sequelizeManager.metadataStore;
    this.entitiesFromClient = reqBody.entities;
    this.saveOptions = reqBody.saveOptions;

    this._keyMappings = [];
    this._fkFixupMap = {};
    this._savedEntities = [];
    this.keyGenerator = sequelizeManager.keyGenerator;

  }

  /** Save the entities in the save request, returning either the saved entities or an error collection */
  save(): Promise<SequelizeSaveResult> {
    let beforeSaveEntity: BeforeSaveEntityFn = (this.beforeSaveEntity || noopBeforeSaveEntity).bind(this);
    let entityTypeMap = {};

    let entityInfos = this.entitiesFromClient.map(entity => {
      // transform entities from how they are sent from the client
      // into entityInfo objects which is how they are exposed
      // to interception on the server.
      let entityAspect = entity.entityAspect;

      let entityTypeName = entityAspect.entityTypeName;
      let entityType = entityTypeMap[entityTypeName];
      if (!entityType) {
        entityType = this.metadataStore.getEntityType(entityTypeName);
        if (entityType) {
          entityTypeMap[entityTypeName] = entityType;
        } else {
          throw new Error("Unable to locate server side metadata for an EntityType named: " + entityTypeName);
        }
      }

      let unmapped = (entity as any).__unmapped;
      let ei: ServerEntityInfo = { entity: entity, entityType: entityType, entityAspect: entityAspect, unmapped: unmapped };
      // just to be sure that we don't try to send it to the db server or return it to the client.
      delete entity.entityAspect;
     
      return ei;
    }, this);

    // create the saveMap (entities to be saved) grouped by entityType
    let saveMapData = _.groupBy(entityInfos, entityInfo => {
      // _.groupBy will bundle all undefined returns together.
      if (beforeSaveEntity(entityInfo)) {
        return entityInfo.entityType.name;
      }
    });
    // remove the entries where beforeSaveEntity returned false ( they are all grouped under 'undefined'
    delete saveMapData["undefined"];

    // want to have SaveMap functions available
    let saveMap = _.extend(new SaveMap(this), saveMapData);

    return this._saveWithTransaction(saveMap);

  }

  private _saveWithTransaction(saveMap: SaveMap): Promise<SequelizeSaveResult> {
    let sequelize = this.sequelizeManager.sequelize;
    return sequelize.transaction().then(trx => {
      // this.transaction = trx;

      let beforeSaveEntities: BeforeSaveEntitiesFn = (this.beforeSaveEntities || noopBeforeSaveEntities).bind(this); 
      // beforeSaveEntities will either return nothing or a promise.
      let nextPromise = Promise.resolve(beforeSaveEntities(saveMap, trx));

      // saveCore returns either a list of entities or an object with an errors property.
      return nextPromise.then(sm => {
        return this._saveCore(saveMap, trx) as any;
      }).then((r: any) => {
        if (r.errors) {
          trx.rollback();
          return r;
        } else {
          trx.commit();
          return { entities: r, keyMappings: this._keyMappings };
        }
      }).catch((e: Error) => {
        trx.rollback();
        throw e;
      });
    });
  };


  private _saveCore(saveMap: SaveMap, transaction: Transaction): Promise<SequelizeRawSaveResult> {
    if (saveMap.entityErrors || saveMap.errorMessage) {
      return Promise.resolve({ errors: saveMap.entityErrors || [], message: saveMap.errorMessage });
    }

    let entityTypes = _.keys(saveMap).map((entityTypeName: string) => {
      // guaranteed to succeed because these have all been looked up earlier.
      return this.metadataStore.getEntityType(entityTypeName);
    }, this);

    let sortedEntityTypes = toposortEntityTypes(entityTypes as EntityType[]);
    let entityGroups = sortedEntityTypes.map((entityType: EntityType) => {
      return { entityType: entityType, entityInfos: saveMap[entityType.name] } as ServerEntityGroup;
    });

    // do adds/updates first followed by deletes in reverse order.
    // add/updates come first because we might move children off of a parent before deleting the parent
    // and we don't want to cause a constraint exception by deleting the parent before all of its
    // children have been moved somewhere else.
    return Promise.reduce(entityGroups, (savedEntities, entityGroup) => {
      return this._processEntityGroup(entityGroup, transaction, false).then(entities => {
        Array.prototype.push.apply(savedEntities, entities);
        return savedEntities;
      });
    }, [] as Entity[]).then(entitiesHandledSoFar => {
      return Promise.reduce(entityGroups.reverse(), (savedEntities, entityGroup) => {
        return this._processEntityGroup(entityGroup, transaction, true).then(entities => {
          Array.prototype.push.apply(savedEntities, entities);
          return savedEntities;
        });
      }, entitiesHandledSoFar);
    });
  }

  private _processEntityGroup(entityGroup: ServerEntityGroup, transaction: Transaction, processDeleted: boolean): Promise<Entity[]> {

    let entityType = entityGroup.entityType;

    let entityInfos = entityGroup.entityInfos.filter(entityInfo => {
      let isDeleted = entityInfo.entityAspect.entityState == "Deleted"
      return processDeleted ? isDeleted : !isDeleted;
    });

    let sqModel = this.sequelizeManager.entityTypeSqModelMap[entityType.name];

    entityInfos = toposortEntityInfos(entityType, entityInfos);
    if (processDeleted) {
      entityInfos = entityInfos.reverse();
    }

    return Promise.reduce(entityInfos, (savedEntities, entityInfo) => {
      // function returns a promise for this entity
      // and updates the results array.
      return this._saveEntityAsync(entityInfo, sqModel, transaction).then(savedEntity => {
        savedEntities.push(savedEntity);
        return savedEntities;
      });
    }, []);
  };

  private _saveEntityAsync(entityInfo: ServerEntityInfo, sqModel: { new(): Model } & typeof Model, transaction: Transaction): Promise<OpenObj> {
    // function returns a promise for this entity
    // and updates the results array.

    // not a "real" entityAspect - just the salient pieces sent from the client.
    let entity = entityInfo.entity;
    let entityAspect = entityInfo.entityAspect;
    let entityType = entityInfo.entityType;
    let entityTypeName = entityType.name;

    // TODO: determine if this is needed because we need to strip the entityAspect off the entity for inserts.
    entityAspect.entity = entity;

    // TODO: we really only need to coerce every field on an insert
    // only selected fields are needed for update and delete.
    this._coerceData(entity, entityType);
    let keyProperties = entityType.keyProperties;
    let firstKeyPropName = keyProperties[0].nameOnServer;

    let entityState = entityAspect.entityState;
    let trxOptions = { transaction: transaction };
    let promise;
    if (entityState === "Added") {
      let keyMapping: KeyMapping = null;
      // NOTE: there are two instances of autoGeneratedKeyType available
      // one on entityType which is part of the metadata and a second
      // on the entityAspect that was sent as part of the save.
      // The one on the entityAspect "overrides" the one on the entityType.

      let autoGeneratedKey = entityAspect.autoGeneratedKey;
      let autoGeneratedKeyType = autoGeneratedKey && autoGeneratedKey.autoGeneratedKeyType;
      let tempKeyValue = entity[firstKeyPropName];
      if (autoGeneratedKeyType && autoGeneratedKeyType !== "None") {
        let realKeyValue: any;
        if (autoGeneratedKeyType == "KeyGenerator") {
          if (this.keyGenerator == null) {
            throw new Error("No KeyGenerator was provided for property:" + keyProperties[0].name + " on entityType: " + entityType.name);
          }
          promise = this.keyGenerator.getNextId(keyProperties[0]).then((nextId: any) => {
            realKeyValue = nextId;
            entity[firstKeyPropName] = realKeyValue;
          });
        } else if (autoGeneratedKeyType == "Identity") {
          let keyDataTypeName = keyProperties[0].dataType.name;
          if (keyDataTypeName === "Guid") {
            // handled here instead of one the db server.
            realKeyValue = createGuid();
            entity[firstKeyPropName] = realKeyValue;
          } else {
            // realValue will be set during 'create' promise resolution below
            realKeyValue = null;
            // value will be set by server's autoincrement logic
            delete entity[firstKeyPropName];
          }
        }
        promise = promise || Promise.resolve(null);
        promise = promise.then(() => {
          // tempKeyValue will be undefined in entity was created on the server
          if (tempKeyValue != undefined) {
            keyMapping = { entityTypeName: entityTypeName, tempValue: tempKeyValue, realValue: realKeyValue };
          }
        })
      }
      promise = promise || Promise.resolve(null);
      return promise.then(() => {
        return sqModel.create(entity, { transaction: transaction }).then((savedEntity: Model) => {
          if (keyMapping) {
            if (keyMapping.realValue === null) {
              keyMapping.realValue = savedEntity[firstKeyPropName];
            }
            let tempKeyString = buildKeyString(entityType, tempKeyValue);
            this._fkFixupMap[tempKeyString] = keyMapping.realValue;
            this._keyMappings.push(keyMapping);
          }
          return this._addToResults((savedEntity as any).dataValues, entityTypeName);
        }).catch(handleItemSaveError(entity, entityState));
      });
    } else if (entityState === "Modified") {
      let whereHash = {};
      keyProperties.forEach(kp => {
        whereHash[kp.nameOnServer] = entity[kp.nameOnServer];
      });

      if (entityType.concurrencyProperties && entityType.concurrencyProperties.length > 0) {
        entityType.concurrencyProperties.forEach(cp => {
          // this is consistent with the client behaviour where it does not update the version property
          // if its data type is binary
          if (cp.dataType.name === 'Binary')
            whereHash[cp.nameOnServer] = entity[cp.nameOnServer];
          else
            whereHash[cp.nameOnServer] = entityAspect.originalValuesMap[cp.nameOnServer];
        });
      }
      let setHash: object;
      if (entityInfo.forceUpdate) {
        setHash = _.clone(entity);
        // remove fields that we don't want to 'set'
        delete (setHash as any).entityAspect;
        // TODO: should we also remove keyProps here...
      } else {
        setHash = {};
        let ovm = entityAspect.originalValuesMap;
        if (ovm == null) {
          throw new Error("Unable to locate an originalValuesMap for one of the 'Modified' entities to be saved");
        }
        Object.keys(ovm).forEach(k => {
          // if k is one of the entityKeys do no allow this
          let isKeyPropName = keyProperties.some(kp => {
            return kp.nameOnServer == k;
          });
          if (isKeyPropName) {
            throw new Error("Breeze does not support updating any part of the entity's key insofar as this changes the identity of the entity");
          }
          setHash[k] = entity[k];
        });
      }
      // don't bother executing update statement if nothing to update
      // this can happen if setModified is called without any properties being changed.
      if (_.isEmpty(setHash)) {
        return Promise.resolve(this._addToResults(entity, entityTypeName));
      }
      return sqModel.update(setHash, { where: whereHash, transaction: transaction }).then(infoArray => {
        let itemsSaved = infoArray[0];
        if (itemsSaved != 1) {
          let err = new Error("unable to update entity - concurrency violation") as any;
          err.entity = entity;
          err.entityState = entityState;
          throw err;
        }
        // HACK: Sequelize 'update' does not return the entity; so
        // we are just returning the original entity here.
        return this._addToResults(entity, entityTypeName);
      }).catch(handleItemSaveError(entity, entityState));
    } else if (entityState === "Deleted") {
      let whereHash = {};
      keyProperties.forEach(kp => {
        whereHash[kp.nameOnServer] = entity[kp.nameOnServer];
      });
      // we don't bother with concurrency check on deletes
      // TODO: we may want to add a 'switch' for this later.
      return sqModel.destroy({ where: whereHash, limit: 1, transaction: transaction }).then(() => {
        // Sequelize 'destroy' does not return the entity; so
        // we are just returning the original entity here.
        return this._addToResults(entity, entityTypeName);
      }).catch(handleItemSaveError(entity, entityState))
    }
  }

  private _addToResults(entity: OpenObj, entityTypeName: string) {
    entity.$type = entityTypeName;
    entity.entityAspect = undefined;
    this._savedEntities.push(entity);
    return entity;
  }

  private _coerceData(entity: ServerEntity, entityType: EntityType) {
    entityType.dataProperties.forEach(dp => {

      let val = entity[dp.nameOnServer];
      if (val != null) {
        if (dp.relatedNavigationProperty != null) {
          // if this is an fk column and it has a value
          // check if there is a fixed up value.
          let key = buildKeyString(dp.relatedNavigationProperty.entityType, val);
          let newVal = this._fkFixupMap[key];
          if (newVal) {
            entity[dp.nameOnServer] = newVal;
          }
        }

        let dtName = dp.dataType.name;
        if (dtName === "DateTime" || dtName === "DateTimeOffset") {
          entity[dp.nameOnServer] = new Date(Date.parse(val));
        }
      } else {
        //      // this allows us to avoid inserting a null.
        //      // TODO: think about an option to allow this if someone really wants to.
        //      delete entity[dp.name];
        //    }
      }
    })
  }

}

function noopBeforeSaveEntities(saveMap: SaveMap, trx?: Transaction) {
  return saveMap;
}

function noopBeforeSaveEntity(entityInfo: ServerEntityInfo) {
  return true;
}

/** Sort the EntityTypes based on their dependencies */
function toposortEntityTypes(entityTypes: EntityType[]) {
  let edges: [EntityType, EntityType][] = [];
  entityTypes.forEach(et => {
    et.foreignKeyProperties.forEach(fkp => {
      if (fkp.relatedNavigationProperty) {
        let dependsOnType = fkp.relatedNavigationProperty.entityType;
        if (et != dependsOnType) {
          edges.push([et, dependsOnType]);
        }
      }
    });
  });
  // this should work but toposort.array seems to have a bug ...
  // let sortedEntityTypes = toposort.array(entityTypes, edges).reverse();
  // so use this instead.
  let allSortedTypes = toposort(edges).reverse();
  allSortedTypes.forEach(function (st, ix) {
    st.index = ix;
  });
  let sortedEntityTypes = entityTypes.sort(function (a, b) {
    return (a as any).index - (b as any).index;
  });
  return sortedEntityTypes;
}

/** Sort the EntityInfos of a given type based foreign key relationships */
function toposortEntityInfos(entityType: EntityType, entityInfos: ServerEntityInfo[]) {
  let edges: [ServerEntityInfo, ServerEntityInfo][] = [];
  let selfReferenceNavProp = _.find(entityType.navigationProperties, navProp => navProp.entityType === entityType);
  if (!selfReferenceNavProp || !selfReferenceNavProp.relatedDataProperties) {
    return entityInfos;
  }

  let fkDataProp = selfReferenceNavProp.relatedDataProperties[0].name;
  let keyProp = entityType.keyProperties[0].name;
  entityInfos.forEach(function (entityInfo) {
    let dependsOn = entityInfo.entity[fkDataProp];
    if (dependsOn) {
      let dependsOnInfo = _.find(entityInfos, x => x.entity[keyProp] === dependsOn && x.entity !== entityInfo.entity); // avoid referencing the same object
      if (dependsOnInfo)
        edges.push([entityInfo, dependsOnInfo]);
    }
  });

  if (edges.length === 0) {
    return entityInfos;
  }

  let allSortedEntityInfos = toposort(edges).reverse();
  allSortedEntityInfos.forEach(function (st, ix) {
    st.__index = ix;
  });
  let sortedEntityInfos = entityInfos.sort(function (a, b) {
    return (a as any).__index - (b as any).__index;
  });
  return sortedEntityInfos;
}

function buildKeyString(entityType: EntityType, val: any) {
  return entityType.name + "::" + val.toString();
}

function handleItemSaveError(entity: any, entityState: EntityState | string) {
  return function (err: any) {
    err = typeof (err) == 'string' ? new Error(err) : err;
    let detailedMsg = (err.name ? "error name: " + err.name : "") + (err.sql ? " sql: " + err.sql : "");
    err.message = err.message ? err.message + ". " + detailedMsg : detailedMsg;
    err.entity = entity;
    err.entityState = entityState;
    throw err;
  }
}

function createGuid() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, function (c) {
    let r = Math.random() * 16 | 0, v = c == 'x' ? r : (r & 0x3 | 0x8);
    return v.toString(16);
  });
}
