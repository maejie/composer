/*
 * IBM Confidential
 * OCO Source Materials
 * IBM Concerto - Blockchain Solution Framework
 * Copyright IBM Corp. 2016
 * The source code for this program is not published or otherwise
 * divested of its trade secrets, irrespective of what has
 * been deposited with the U.S. Copyright Office.
 */

'use strict';

const ClassDeclaration = require('../introspect/classdeclaration');
const Field = require('../introspect/field');
const RelationshipDeclaration = require('../introspect/relationshipdeclaration');
const Util = require('../util');
const ModelUtil = require('../modelutil');

/**
 * Populates a Resource with data from a JSON object graph. The JSON objects
 * should be the result of calling Serializer.toJSON and then JSON.parse.
 * The parameters object should contain the keys
 * 'stack' - the TypedStack of objects being processed. It should
 * start with the root object from JSON.parse.
 * 'factory' - the Factory instance to use for creating objects.
 * 'modelManager' - the ModelManager instance to use to resolve classes
 * @private
 * @class
 * @memberof module:ibm-concerto-common
 */
class JSONPopulator {

    /**
     * Constructor.
     * @param {boolean} [acceptResourcesForRelationships] Permit resources in the
     * place of relationships, false by default.
     */
    constructor(acceptResourcesForRelationships) {
        this.acceptResourcesForRelationships = acceptResourcesForRelationships;
    }

    /**
     * Visitor design pattern
     * @param {Object} thing - the object being visited
     * @param {Object} parameters  - the parameter
     * @return {Object} the result of visiting or null
     * @private
     */
    visit(thing, parameters) {
        if (thing instanceof ClassDeclaration) {
            return this.visitClassDeclaration(thing, parameters);
        } else if (thing instanceof RelationshipDeclaration) {
            return this.visitRelationshipDeclaration(thing, parameters);
        } else if (thing instanceof Field) {
            return this.visitField(thing, parameters);
        } else {
            throw new Error('Unrecognised ' + JSON.stringify(thing) );
        }
    }

    /**
     * Visitor design pattern
     * @param {ClassDeclaration} classDeclaration - the object being visited
     * @param {Object} parameters  - the parameter
     * @return {Object} the result of visiting or null
     * @private
     */
    visitClassDeclaration(classDeclaration, parameters) {
        const jsonObj = parameters.jsonStack.pop();
        const resourceObj = parameters.resourceStack.pop();

        const properties = classDeclaration.getProperties();
        for(let n=0; n < properties.length; n++) {
            const property = properties[n];
            const value = jsonObj[property.getName()];
            if(!Util.isNull(value)) {
                parameters.jsonStack.push(value);
                resourceObj[property.getName()] = property.accept(this,parameters);
            }
        }
        return resourceObj;
    }

    /**
     * Visitor design pattern
     * @param {Field} field - the object being visited
     * @param {Object} parameters  - the parameter
     * @return {Object} the result of visiting or null
     * @private
     */
    visitField(field, parameters) {
        const jsonObj = parameters.jsonStack.pop();
        let result = null;

        if(field.isArray()) {
            result = [];
            for(let n=0; n < jsonObj.length; n++) {
                const jsonItem = jsonObj[n];
                result.push(this.convertItem(field,jsonItem, parameters));
            }
        }
        else {
            result = this.convertItem(field,jsonObj, parameters);
        }

        return result;
    }


    /**
    *
    * @param {Field} field - the field of the item being converted
    * @param {Object} jsonItem - the JSON object of the item being converted
    * @param {Object} parameters - the parameters
    * @return {Object} - the populated object.
    */
    convertItem(field, jsonItem, parameters) {
        let result = null;

        if(!field.isPrimitive() && !field.isTypeEnum()) {
            let typeName = jsonItem.$class;
            if(!typeName) {
                // If the type name is not specified in the data, then use the
                // type name from the model. This will only happen in the case of
                // a sub resource inside another resource.
                typeName = field.getFullyQualifiedTypeName();
            }

            // This throws if the type does not exist.
            const classDeclaration = parameters.modelManager.getType(typeName);

            // create a new instance, using the identifier field name as the ID.
            let subResource = null;

            // if this is identifiable, then we create a resource
            if(!classDeclaration.isConcept()) {
                subResource = parameters.factory.newInstance(classDeclaration.getModelFile().getNamespace(),
              classDeclaration.getName(), jsonItem[classDeclaration.getIdentifierFieldName()] );
            }
            else {
              // otherwise we create a concept
                subResource = parameters.factory.newConcept(classDeclaration.getModelFile().getNamespace(),
                            classDeclaration.getName() );
            }

            result = subResource;
            parameters.resourceStack.push(subResource);
            parameters.jsonStack.push(jsonItem);
            classDeclaration.accept(this, parameters);
        }
        else {
            result = this.convertToObject(field,jsonItem);
        }

        return result;
    }

    /**
     * Converts a primtive object to JSON text.
     *
     * @param {Field} field - the field declaration of the object
     * @param {Object} json - the JSON object to convert to a Concerto Object
     * @return {string} the text representation
     */
    convertToObject(field, json) {
        let result = null;

        switch(field.getType()) {
        case 'DateTime':
            result = new Date(json);
            break;
        case 'Integer':
        case 'Long':
            result = parseInt(json);
            break;
        case 'Double':
            result = parseFloat(json);
            break;
        case 'Boolean':
            result = (json === true || json === 'true');
            break;
        case 'String':
            result = json.toString();
            break;
        default:
            // everything else should be an enumerated value...
            result = json;
        }

        return result;
    }

    /**
     * Visitor design pattern
     * @param {RelationshipDeclaration} relationshipDeclaration - the object being visited
     * @param {Object} parameters  - the parameter
     * @return {Object} the result of visiting or null
     * @private
     */
    visitRelationshipDeclaration(relationshipDeclaration, parameters) {
        const jsonObj = parameters.jsonStack.pop();
        let result = null;

        let typeFQN = relationshipDeclaration.getFullyQualifiedTypeName();
        let namespace = ModelUtil.getNamespace(typeFQN);
        if(!namespace) {
            namespace = relationshipDeclaration.getNamespace();
        }
        let type = ModelUtil.getShortName(typeFQN);

        if(relationshipDeclaration.isArray()) {
            result = [];
            for(let n=0; n < jsonObj.length; n++) {
                let jsonItem = jsonObj[n];
                if (typeof jsonItem === 'string') {
                    result.push(parameters.factory.newRelationship(namespace, type, jsonItem));
                } else {
                    if (!this.acceptResourcesForRelationships) {
                        throw new Error('Invalid JSON data. Found a value that is not a string: ' + jsonObj + ' for relationship ' + relationshipDeclaration);
                    }

                    // this isn't a relationship, but it might be an object!
                    if(!jsonItem.$class) {
                        throw new Error('Invalid JSON data. Does not contain a $class type identifier: ' + jsonItem + ' for relationship ' + relationshipDeclaration );
                    }

                    const classDeclaration = parameters.modelManager.getType(jsonItem.$class);
                    if(!classDeclaration) {
                        throw new Error( 'Failed to find type ' + jsonItem.$class + ' in ModelManager.' );
                    }

                    // create a new instance, using the identifier field name as the ID.
                    let subResource = parameters.factory.newInstance(classDeclaration.getModelFile().getNamespace(),
                        classDeclaration.getName(), jsonItem[classDeclaration.getIdentifierFieldName()] );
                    parameters.jsonStack.push(jsonItem);
                    parameters.resourceStack.push(subResource);
                    classDeclaration.accept(this, parameters);
                    result.push(subResource);
                }
            }
        }
        else {
            if (typeof jsonObj === 'string') {
                result = parameters.factory.newRelationship(namespace, type, jsonObj);
            } else {
                if (!this.acceptResourcesForRelationships) {
                    throw new Error('Invalid JSON data. Found a value that is not a string: ' + jsonObj + ' for relationship ' + relationshipDeclaration);
                }

                // this isn't a relationship, but it might be an object!
                if(!jsonObj.$class) {
                    throw new Error('Invalid JSON data. Does not contain a $class type identifier: ' + jsonObj + ' for relationship ' + relationshipDeclaration );
                }

                const classDeclaration = parameters.modelManager.getType(jsonObj.$class);
                if(!classDeclaration) {
                    throw new Error( 'Failed to find type ' + jsonObj.$class + ' in ModelManager.' );
                }

                // create a new instance, using the identifier field name as the ID.
                let subResource = parameters.factory.newInstance(classDeclaration.getModelFile().getNamespace(),
                    classDeclaration.getName(), jsonObj[classDeclaration.getIdentifierFieldName()] );
                parameters.jsonStack.push(jsonObj);
                parameters.resourceStack.push(subResource);
                classDeclaration.accept(this, parameters);
                result = subResource;
            }
        }
        return result;
    }
}

module.exports = JSONPopulator;
