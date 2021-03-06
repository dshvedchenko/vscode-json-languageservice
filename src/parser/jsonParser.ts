/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/
'use strict';

import * as Json from 'jsonc-parser';
import { JSONSchema, JSONSchemaRef } from '../jsonSchema';
import * as objects from '../utils/objects';

import * as nls from 'vscode-nls';
import Uri from 'vscode-uri';
import { TextDocument } from 'vscode-languageserver-types';

const localize = nls.loadMessageBundle();

export interface IRange {
	start: number;
	end: number;
}

export enum ErrorCode {
	Undefined = 0,
	EnumValueMismatch = 1,
	UnexpectedEndOfComment = 0x101,
	UnexpectedEndOfString = 0x102,
	UnexpectedEndOfNumber = 0x103,
	InvalidUnicode = 0x104,
	InvalidEscapeCharacter = 0x105,
	InvalidCharacter = 0x106,
	PropertyExpected = 0x201,
	CommaExpected = 0x202,
	ColonExpected = 0x203,
	ValueExpected = 0x204,
	CommaOrCloseBacketExpected = 0x205,
	CommaOrCloseBraceExpected = 0x206,
	TrailingComma = 0x207
}

const colorHexPattern = /^#([0-9A-Fa-f]{3,4}|([0-9A-Fa-f]{2}){3,4})$/;
const emailPattern = /^(([^<>()\[\]\\.,;:\s@"]+(\.[^<>()\[\]\\.,;:\s@"]+)*)|(".+"))@((\[[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}\.[0-9]{1,3}])|(([a-zA-Z\-0-9]+\.)+[a-zA-Z]{2,}))$/;

export enum ProblemSeverity {
	Ignore = 'ignore', Error = 'error', Warning = 'warning'
}

export interface IProblem {
	location: IRange;
	severity: ProblemSeverity;
	code?: ErrorCode;
	message: string;
}

export class ASTNode {
	public start: number;
	public end: number;
	public type: string;
	public parent: ASTNode;

	public location: Json.Segment;

	constructor(parent: ASTNode, type: string, location: Json.Segment, start: number, end?: number) {
		this.type = type;
		this.location = location;
		this.start = start;
		this.end = end;
		this.parent = parent;
	}

	public getPath(): Json.JSONPath {
		let path = this.parent ? this.parent.getPath() : [];
		if (this.location !== null) {
			path.push(this.location);
		}
		return path;
	}


	public getChildNodes(): ASTNode[] {
		return [];
	}

	public getLastChild(): ASTNode {
		return null;
	}

	public getValue(): any {
		// override in children
		return;
	}

	public contains(offset: number, includeRightBound: boolean = false): boolean {
		return offset >= this.start && offset < this.end || includeRightBound && offset === this.end;
	}

	public toString(): string {
		return 'type: ' + this.type + ' (' + this.start + '/' + this.end + ')' + (this.parent ? ' parent: {' + this.parent.toString() + '}' : '');
	}

	public visit(visitor: (node: ASTNode) => boolean): boolean {
		return visitor(this);
	}

	public getNodeFromOffset(offset: number): ASTNode {
		let findNode = (node: ASTNode): ASTNode => {
			if (offset >= node.start && offset < node.end) {
				let children = node.getChildNodes();
				for (let i = 0; i < children.length && children[i].start <= offset; i++) {
					let item = findNode(children[i]);
					if (item) {
						return item;
					}
				}
				return node;
			}
			return null;
		};
		return findNode(this);
	}

	public getNodeFromOffsetEndInclusive(offset: number): ASTNode {
		let findNode = (node: ASTNode): ASTNode => {
			if (offset >= node.start && offset <= node.end) {
				let children = node.getChildNodes();
				for (let i = 0; i < children.length && children[i].start <= offset; i++) {
					let item = findNode(children[i]);
					if (item) {
						return item;
					}
				}
				return node;
			}
			return null;
		};
		return findNode(this);
	}

	public validate(schema: JSONSchema, validationResult: ValidationResult, matchingSchemas: ISchemaCollector): void {
		if (!matchingSchemas.include(this)) {
			return;
		}

		if (Array.isArray(schema.type)) {
			if ((<string[]>schema.type).indexOf(this.type) === -1) {
				validationResult.problems.push({
					location: { start: this.start, end: this.end },
					severity: ProblemSeverity.Warning,
					message: schema.errorMessage || localize('typeArrayMismatchWarning', 'Incorrect type. Expected one of {0}.', (<string[]>schema.type).join(', '))
				});
			}
		}
		else if (schema.type) {
			if (this.type !== schema.type) {
				validationResult.problems.push({
					location: { start: this.start, end: this.end },
					severity: ProblemSeverity.Warning,
					message: schema.errorMessage || localize('typeMismatchWarning', 'Incorrect type. Expected "{0}".', schema.type)
				});
			}
		}
		if (Array.isArray(schema.allOf)) {
			schema.allOf.forEach(subSchemaRef => {
				this.validate(asSchema(subSchemaRef), validationResult, matchingSchemas);
			});
		}
		let notSchema = asSchema(schema.not);
		if (notSchema) {
			let subValidationResult = new ValidationResult();
			let subMatchingSchemas = matchingSchemas.newSub();
			this.validate(notSchema, subValidationResult, subMatchingSchemas);
			if (!subValidationResult.hasProblems()) {
				validationResult.problems.push({
					location: { start: this.start, end: this.end },
					severity: ProblemSeverity.Warning,
					message: localize('notSchemaWarning', "Matches a schema that is not allowed.")
				});
			}
			subMatchingSchemas.schemas.forEach((ms) => {
				ms.inverted = !ms.inverted;
				matchingSchemas.add(ms);
			});
		}

		let testAlternatives = (alternatives: JSONSchemaRef[], maxOneMatch: boolean) => {
			let matches = [];

			// remember the best match that is used for error messages
			let bestMatch: { schema: JSONSchema; validationResult: ValidationResult; matchingSchemas: ISchemaCollector; } = null;
			alternatives.forEach(subSchemaRef => {
				let subSchema = asSchema(subSchemaRef);
				let subValidationResult = new ValidationResult();
				let subMatchingSchemas = matchingSchemas.newSub();
				this.validate(subSchema, subValidationResult, subMatchingSchemas);
				if (!subValidationResult.hasProblems()) {
					matches.push(subSchema);
				}
				if (!bestMatch) {
					bestMatch = { schema: subSchema, validationResult: subValidationResult, matchingSchemas: subMatchingSchemas };
				} else {
					if (!maxOneMatch && !subValidationResult.hasProblems() && !bestMatch.validationResult.hasProblems()) {
						// no errors, both are equally good matches
						bestMatch.matchingSchemas.merge(subMatchingSchemas);
						bestMatch.validationResult.propertiesMatches += subValidationResult.propertiesMatches;
						bestMatch.validationResult.propertiesValueMatches += subValidationResult.propertiesValueMatches;
					} else {
						let compareResult = subValidationResult.compare(bestMatch.validationResult);
						if (compareResult > 0) {
							// our node is the best matching so far
							bestMatch = { schema: subSchema, validationResult: subValidationResult, matchingSchemas: subMatchingSchemas };
						} else if (compareResult === 0) {
							// there's already a best matching but we are as good
							bestMatch.matchingSchemas.merge(subMatchingSchemas);
							bestMatch.validationResult.mergeEnumValues(subValidationResult);
						}
					}
				}
			});

			if (matches.length > 1 && maxOneMatch) {
				validationResult.problems.push({
					location: { start: this.start, end: this.start + 1 },
					severity: ProblemSeverity.Warning,
					message: localize('oneOfWarning', "Matches multiple schemas when only one must validate.")
				});
			}
			if (bestMatch !== null) {
				validationResult.merge(bestMatch.validationResult);
				validationResult.propertiesMatches += bestMatch.validationResult.propertiesMatches;
				validationResult.propertiesValueMatches += bestMatch.validationResult.propertiesValueMatches;
				matchingSchemas.merge(bestMatch.matchingSchemas);
			}
			return matches.length;
		};
		if (Array.isArray(schema.anyOf)) {
			testAlternatives(schema.anyOf, false);
		}
		if (Array.isArray(schema.oneOf)) {
			testAlternatives(schema.oneOf, true);
		}

		if (Array.isArray(schema.enum)) {
			let val = this.getValue();
			let enumValueMatch = false;
			for (let e of schema.enum) {
				if (objects.equals(val, e)) {
					enumValueMatch = true;
					break;
				}
			}
			validationResult.enumValues = schema.enum;
			validationResult.enumValueMatch = enumValueMatch;
			if (!enumValueMatch) {
				validationResult.problems.push({
					location: { start: this.start, end: this.end },
					severity: ProblemSeverity.Warning,
					code: ErrorCode.EnumValueMismatch,
					message: schema.errorMessage || localize('enumWarning', 'Value is not accepted. Valid values: {0}.', schema.enum.map(v => JSON.stringify(v)).join(', '))
				});
			}
		}

		if (schema.const) {
			let val = this.getValue();
			if (!objects.equals(val, schema.const)) {
				validationResult.problems.push({
					location: { start: this.start, end: this.end },
					severity: ProblemSeverity.Warning,
					code: ErrorCode.EnumValueMismatch,
					message: schema.errorMessage || localize('constWarning', 'Value must be {0}.', JSON.stringify(schema.const))
				});
				validationResult.enumValueMatch = false;
			} else {
				validationResult.enumValueMatch = true;
			}
			validationResult.enumValues = [schema.const];
		}

		if (schema.deprecationMessage && this.parent) {
			validationResult.problems.push({
				location: { start: this.parent.start, end: this.parent.end },
				severity: ProblemSeverity.Warning,
				message: schema.deprecationMessage
			});
		}
		matchingSchemas.add({ node: this, schema: schema });
	}
}

export class NullASTNode extends ASTNode {

	constructor(parent: ASTNode, name: Json.Segment, start: number, end?: number) {
		super(parent, 'null', name, start, end);
	}

	public getValue(): any {
		return null;
	}
}

export class BooleanASTNode extends ASTNode {

	private value: boolean;

	constructor(parent: ASTNode, name: Json.Segment, value: boolean, start: number, end?: number) {
		super(parent, 'boolean', name, start, end);
		this.value = value;
	}

	public getValue(): any {
		return this.value;
	}

}

export class ArrayASTNode extends ASTNode {

	public items: ASTNode[];

	constructor(parent: ASTNode, name: Json.Segment, start: number, end?: number) {
		super(parent, 'array', name, start, end);
		this.items = [];
	}

	public getChildNodes(): ASTNode[] {
		return this.items;
	}

	public getLastChild(): ASTNode {
		return this.items[this.items.length - 1];
	}

	public getValue(): any {
		return this.items.map((v) => v.getValue());
	}

	public addItem(item: ASTNode): boolean {
		if (item) {
			this.items.push(item);
			return true;
		}
		return false;
	}

	public visit(visitor: (node: ASTNode) => boolean): boolean {
		let ctn = visitor(this);
		for (let i = 0; i < this.items.length && ctn; i++) {
			ctn = this.items[i].visit(visitor);
		}
		return ctn;
	}

	public validate(schema: JSONSchema, validationResult: ValidationResult, matchingSchemas: ISchemaCollector): void {
		if (!matchingSchemas.include(this)) {
			return;
		}
		super.validate(schema, validationResult, matchingSchemas);

		if (Array.isArray(schema.items)) {
			let subSchemas = schema.items;
			subSchemas.forEach((subSchemaRef, index) => {
				let subSchema = asSchema(subSchemaRef);
				let itemValidationResult = new ValidationResult();
				let item = this.items[index];
				if (item) {
					item.validate(subSchema, itemValidationResult, matchingSchemas);
					validationResult.mergePropertyMatch(itemValidationResult);
				} else if (this.items.length >= subSchemas.length) {
					validationResult.propertiesValueMatches++;
				}
			});
			if (this.items.length > subSchemas.length) {
				if (typeof schema.additionalItems === 'object') {
					for (let i = subSchemas.length; i < this.items.length; i++) {
						let itemValidationResult = new ValidationResult();
						this.items[i].validate(<any>schema.additionalItems, itemValidationResult, matchingSchemas);
						validationResult.mergePropertyMatch(itemValidationResult);
					}
				} else if (schema.additionalItems === false) {
					validationResult.problems.push({
						location: { start: this.start, end: this.end },
						severity: ProblemSeverity.Warning,
						message: localize('additionalItemsWarning', 'Array has too many items according to schema. Expected {0} or fewer.', subSchemas.length)
					});
				}
			}
		} else {
			let itemSchema = asSchema(schema.items);
			if (itemSchema) {
				this.items.forEach((item) => {
					let itemValidationResult = new ValidationResult();
					item.validate(itemSchema, itemValidationResult, matchingSchemas);
					validationResult.mergePropertyMatch(itemValidationResult);
				});
			}
		}

		let containsSchema = asSchema(schema.contains);
		if (containsSchema) {
			let doesContain = this.items.some(item => {
				let itemValidationResult = new ValidationResult();
				item.validate(containsSchema, itemValidationResult, NoOpSchemaCollector.instance);
				return !itemValidationResult.hasProblems();
			});

			if (!doesContain) {
				validationResult.problems.push({
					location: { start: this.start, end: this.end },
					severity: ProblemSeverity.Warning,
					message: schema.errorMessage || localize('requiredItemMissingWarning', 'Array does not contain required item.', schema.minItems)
				});
			}
		}

		if (schema.minItems && this.items.length < schema.minItems) {
			validationResult.problems.push({
				location: { start: this.start, end: this.end },
				severity: ProblemSeverity.Warning,
				message: localize('minItemsWarning', 'Array has too few items. Expected {0} or more.', schema.minItems)
			});
		}

		if (schema.maxItems && this.items.length > schema.maxItems) {
			validationResult.problems.push({
				location: { start: this.start, end: this.end },
				severity: ProblemSeverity.Warning,
				message: localize('maxItemsWarning', 'Array has too many items. Expected {0} or fewer.', schema.minItems)
			});
		}

		if (schema.uniqueItems === true) {
			let values = this.items.map((node) => {
				return node.getValue();
			});
			let duplicates = values.some((value, index) => {
				return index !== values.lastIndexOf(value);
			});
			if (duplicates) {
				validationResult.problems.push({
					location: { start: this.start, end: this.end },
					severity: ProblemSeverity.Warning,
					message: localize('uniqueItemsWarning', 'Array has duplicate items.')
				});
			}
		}
	}
}

export class NumberASTNode extends ASTNode {

	public isInteger: boolean;
	public value: number;

	constructor(parent: ASTNode, name: Json.Segment, start: number, end?: number) {
		super(parent, 'number', name, start, end);
		this.isInteger = true;
		this.value = Number.NaN;
	}

	public getValue(): any {
		return this.value;
	}

	public validate(schema: JSONSchema, validationResult: ValidationResult, matchingSchemas: ISchemaCollector): void {
		if (!matchingSchemas.include(this)) {
			return;
		}

		// work around type validation in the base class
		let typeIsInteger = false;
		if (schema.type === 'integer' || (Array.isArray(schema.type) && (<string[]>schema.type).indexOf('integer') !== -1)) {
			typeIsInteger = true;
		}
		if (typeIsInteger && this.isInteger === true) {
			this.type = 'integer';
		}
		super.validate(schema, validationResult, matchingSchemas);
		this.type = 'number';

		let val = this.getValue();

		if (typeof schema.multipleOf === 'number') {
			if (val % schema.multipleOf !== 0) {
				validationResult.problems.push({
					location: { start: this.start, end: this.end },
					severity: ProblemSeverity.Warning,
					message: localize('multipleOfWarning', 'Value is not divisible by {0}.', schema.multipleOf)
				});
			}
		}
		function getExclusiveLimit(limit: number | undefined, exclusive: boolean | number | undefined): number | undefined {
			if (typeof exclusive === 'number') {
				return exclusive;
			}
			if (typeof exclusive === 'boolean' && exclusive) {
				return limit;
			}
			return void 0;
		}
		function getLimit(limit: number | undefined, exclusive: boolean | number | undefined): number | undefined {
			if (typeof exclusive !== 'boolean' || !exclusive) {
				return limit;
			}
			return void 0;
		}
		let exclusiveMinimum = getExclusiveLimit(schema.minimum, schema.exclusiveMinimum);
		if (typeof exclusiveMinimum === 'number' && val <= exclusiveMinimum) {
			validationResult.problems.push({
				location: { start: this.start, end: this.end },
				severity: ProblemSeverity.Warning,
				message: localize('exclusiveMinimumWarning', 'Value is below the exclusive minimum of {0}.', exclusiveMinimum)
			});
		}
		let exclusiveMaximum = getExclusiveLimit(schema.maximum, schema.exclusiveMaximum);
		if (typeof exclusiveMaximum === 'number' && val >= exclusiveMaximum) {
			validationResult.problems.push({
				location: { start: this.start, end: this.end },
				severity: ProblemSeverity.Warning,
				message: localize('exclusiveMaximumWarning', 'Value is above the exclusive maximum of {0}.', exclusiveMaximum)
			});
		}
		let minimum = getLimit(schema.minimum, schema.exclusiveMinimum);
		if (typeof minimum === 'number' && val < minimum) {
			validationResult.problems.push({
				location: { start: this.start, end: this.end },
				severity: ProblemSeverity.Warning,
				message: localize('minimumWarning', 'Value is below the minimum of {0}.', minimum)
			});
		}
		let maximum = getLimit(schema.maximum, schema.exclusiveMaximum);
		if (typeof maximum === 'number' && val > maximum) {
			validationResult.problems.push({
				location: { start: this.start, end: this.end },
				severity: ProblemSeverity.Warning,
				message: localize('maximumWarning', 'Value is above the maximum of {0}.', maximum)
			});
		}

	}
}


export class StringASTNode extends ASTNode {
	public isKey: boolean;
	public value: string;

	constructor(parent: ASTNode, name: Json.Segment, isKey: boolean, start: number, end?: number) {
		super(parent, 'string', name, start, end);
		this.isKey = isKey;
		this.value = '';
	}

	public getValue(): any {
		return this.value;
	}

	public validate(schema: JSONSchema, validationResult: ValidationResult, matchingSchemas: ISchemaCollector): void {
		if (!matchingSchemas.include(this)) {
			return;
		}
		super.validate(schema, validationResult, matchingSchemas);

		if (schema.minLength && this.value.length < schema.minLength) {
			validationResult.problems.push({
				location: { start: this.start, end: this.end },
				severity: ProblemSeverity.Warning,
				message: localize('minLengthWarning', 'String is shorter than the minimum length of {0}.', schema.minLength)
			});
		}

		if (schema.maxLength && this.value.length > schema.maxLength) {
			validationResult.problems.push({
				location: { start: this.start, end: this.end },
				severity: ProblemSeverity.Warning,
				message: localize('maxLengthWarning', 'String is longer than the maximum length of {0}.', schema.maxLength)
			});
		}

		if (schema.pattern) {
			let regex = new RegExp(schema.pattern);
			if (!regex.test(this.value)) {
				validationResult.problems.push({
					location: { start: this.start, end: this.end },
					severity: ProblemSeverity.Warning,
					message: schema.patternErrorMessage || schema.errorMessage || localize('patternWarning', 'String does not match the pattern of "{0}".', schema.pattern)
				});
			}
		}

		if (schema.format) {
			switch (schema.format) {
				case 'uri':
				case 'uri-reference': {
					let errorMessage;
					if (!this.value) {
						errorMessage = localize('uriEmpty', 'URI expected.');
					} else {
						try {
							let uri = Uri.parse(this.value);
							if (!uri.scheme && schema.format === 'uri') {
								errorMessage = localize('uriSchemeMissing', 'URI with a scheme is expected.');
							}
						} catch (e) {
							errorMessage = e.message;
						}
					}
					if (errorMessage) {
						validationResult.problems.push({
							location: { start: this.start, end: this.end },
							severity: ProblemSeverity.Warning,
							message: schema.patternErrorMessage || schema.errorMessage || localize('uriFormatWarning', 'String is not a URI: {0}', errorMessage)
						});
					}
				}
					break;
				case 'email': {
					if (!this.value.match(emailPattern)) {
						validationResult.problems.push({
							location: { start: this.start, end: this.end },
							severity: ProblemSeverity.Warning,
							message: schema.patternErrorMessage || schema.errorMessage || localize('emailFormatWarning', 'String is not an e-mail address.')
						});
					}
				}
					break;
				case 'color-hex': {
					if (!this.value.match(colorHexPattern)) {
						validationResult.problems.push({
							location: { start: this.start, end: this.end },
							severity: ProblemSeverity.Warning,
							message: schema.patternErrorMessage || schema.errorMessage || localize('colorHexFormatWarning', 'Invalid color format. Use #RGB, #RGBA, #RRGGBB or #RRGGBBAA.')
						});
					}
				}
					break;
				default:
			}
		}
	}
}

export class PropertyASTNode extends ASTNode {
	public key: StringASTNode;
	public value: ASTNode;
	public colonOffset: number;

	constructor(parent: ASTNode, key: StringASTNode) {
		super(parent, 'property', null, key.start);
		this.key = key;
		key.parent = this;
		key.location = key.value;
		this.colonOffset = -1;
	}

	public getChildNodes(): ASTNode[] {
		return this.value ? [this.key, this.value] : [this.key];
	}

	public getLastChild(): ASTNode {
		return this.value;
	}

	public setValue(value: ASTNode): boolean {
		this.value = value;
		return value !== null;
	}

	public visit(visitor: (node: ASTNode) => boolean): boolean {
		return visitor(this) && this.key.visit(visitor) && this.value && this.value.visit(visitor);
	}

	public validate(schema: JSONSchema, validationResult: ValidationResult, matchingSchemas: ISchemaCollector): void {
		if (!matchingSchemas.include(this)) {
			return;
		}
		if (this.value) {
			this.value.validate(schema, validationResult, matchingSchemas);
		}
	}
}

export class ObjectASTNode extends ASTNode {
	public properties: PropertyASTNode[];

	constructor(parent: ASTNode, name: Json.Segment, start: number, end?: number) {
		super(parent, 'object', name, start, end);

		this.properties = [];
	}

	public getChildNodes(): ASTNode[] {
		return this.properties;
	}

	public getLastChild(): ASTNode {
		return this.properties[this.properties.length - 1];
	}

	public addProperty(node: PropertyASTNode): boolean {
		if (!node) {
			return false;
		}
		this.properties.push(node);
		return true;
	}

	public getFirstProperty(key: string): PropertyASTNode {
		for (let i = 0; i < this.properties.length; i++) {
			if (this.properties[i].key.value === key) {
				return this.properties[i];
			}
		}
		return null;
	}

	public getKeyList(): string[] {
		return this.properties.map((p) => p.key.getValue());
	}

	public getValue(): any {
		let value: any = Object.create(null);
		this.properties.forEach((p) => {
			let v = p.value && p.value.getValue();
			if (typeof v !== 'undefined') {
				value[p.key.getValue()] = v;
			}
		});
		return value;
	}

	public visit(visitor: (node: ASTNode) => boolean): boolean {
		let ctn = visitor(this);
		for (let i = 0; i < this.properties.length && ctn; i++) {
			ctn = this.properties[i].visit(visitor);
		}
		return ctn;
	}

	public validate(schema: JSONSchema, validationResult: ValidationResult, matchingSchemas: ISchemaCollector): void {
		if (!matchingSchemas.include(this)) {
			return;
		}

		super.validate(schema, validationResult, matchingSchemas);
		let seenKeys: { [key: string]: ASTNode } = Object.create(null);
		let unprocessedProperties: string[] = [];
		this.properties.forEach((node) => {
			let key = node.key.value;
			seenKeys[key] = node.value;
			unprocessedProperties.push(key);
		});

		if (Array.isArray(schema.required)) {
			schema.required.forEach((propertyName: string) => {
				if (!seenKeys[propertyName]) {
					let key = this.parent && this.parent && (<PropertyASTNode>this.parent).key;
					let location = key ? { start: key.start, end: key.end } : { start: this.start, end: this.start + 1 };
					validationResult.problems.push({
						location: location,
						severity: ProblemSeverity.Warning,
						message: localize('MissingRequiredPropWarning', 'Missing property "{0}".', propertyName)
					});
				}
			});
		}


		let propertyProcessed = (prop: string) => {
			let index = unprocessedProperties.indexOf(prop);
			while (index >= 0) {
				unprocessedProperties.splice(index, 1);
				index = unprocessedProperties.indexOf(prop);
			}
		};

		if (schema.properties) {
			Object.keys(schema.properties).forEach((propertyName: string) => {
				propertyProcessed(propertyName);
				let propertySchema = schema.properties[propertyName];
				let child = seenKeys[propertyName];
				if (child) {
					if (typeof propertySchema === 'boolean') {
						if (!propertySchema) {
							let propertyNode = <PropertyASTNode>child.parent;
							validationResult.problems.push({
								location: { start: propertyNode.key.start, end: propertyNode.key.end },
								severity: ProblemSeverity.Warning,
								message: schema.errorMessage || localize('DisallowedExtraPropWarning', 'Property {0} is not allowed.', propertyName)
							});
						} else {
							validationResult.propertiesMatches++;
							validationResult.propertiesValueMatches++;
						}
					} else {
						let propertyValidationResult = new ValidationResult();
						child.validate(propertySchema, propertyValidationResult, matchingSchemas);
						validationResult.mergePropertyMatch(propertyValidationResult);
					}
				}

			});
		}

		if (schema.patternProperties) {
			Object.keys(schema.patternProperties).forEach((propertyPattern: string) => {
				let regex = new RegExp(propertyPattern);
				unprocessedProperties.slice(0).forEach((propertyName: string) => {
					if (regex.test(propertyName)) {
						propertyProcessed(propertyName);
						let child = seenKeys[propertyName];
						if (child) {
							let propertySchema = schema.patternProperties[propertyPattern];
							if (typeof propertySchema === 'boolean') {
								if (!propertySchema) {
									let propertyNode = <PropertyASTNode>child.parent;
									validationResult.problems.push({
										location: { start: propertyNode.key.start, end: propertyNode.key.end },
										severity: ProblemSeverity.Warning,
										message: schema.errorMessage || localize('DisallowedExtraPropWarning', 'Property {0} is not allowed.', propertyName)
									});
								} else {
									validationResult.propertiesMatches++;
									validationResult.propertiesValueMatches++;
								}
							} else {
								let propertyValidationResult = new ValidationResult();
								child.validate(propertySchema, propertyValidationResult, matchingSchemas);
								validationResult.mergePropertyMatch(propertyValidationResult);
							}
						}
					}
				});
			});
		}

		if (typeof schema.additionalProperties === 'object') {
			unprocessedProperties.forEach((propertyName: string) => {
				let child = seenKeys[propertyName];
				if (child) {
					let propertyValidationResult = new ValidationResult();
					child.validate(<any>schema.additionalProperties, propertyValidationResult, matchingSchemas);
					validationResult.mergePropertyMatch(propertyValidationResult);
				}
			});
		} else if (schema.additionalProperties === false) {
			if (unprocessedProperties.length > 0) {
				unprocessedProperties.forEach((propertyName: string) => {
					let child = seenKeys[propertyName];
					if (child) {
						let propertyNode = <PropertyASTNode>child.parent;

						validationResult.problems.push({
							location: { start: propertyNode.key.start, end: propertyNode.key.end },
							severity: ProblemSeverity.Warning,
							message: schema.errorMessage || localize('DisallowedExtraPropWarning', 'Property {0} is not allowed.', propertyName)
						});
					}
				});
			}
		}

		if (schema.maxProperties) {
			if (this.properties.length > schema.maxProperties) {
				validationResult.problems.push({
					location: { start: this.start, end: this.end },
					severity: ProblemSeverity.Warning,
					message: localize('MaxPropWarning', 'Object has more properties than limit of {0}.', schema.maxProperties)
				});
			}
		}

		if (schema.minProperties) {
			if (this.properties.length < schema.minProperties) {
				validationResult.problems.push({
					location: { start: this.start, end: this.end },
					severity: ProblemSeverity.Warning,
					message: localize('MinPropWarning', 'Object has fewer properties than the required number of {0}', schema.minProperties)
				});
			}
		}

		if (schema.dependencies) {
			Object.keys(schema.dependencies).forEach((key: string) => {
				let prop = seenKeys[key];
				if (prop) {
					let propertyDep = schema.dependencies[key];
					if (Array.isArray(propertyDep)) {
						propertyDep.forEach((requiredProp: string) => {
							if (!seenKeys[requiredProp]) {
								validationResult.problems.push({
									location: { start: this.start, end: this.end },
									severity: ProblemSeverity.Warning,
									message: localize('RequiredDependentPropWarning', 'Object is missing property {0} required by property {1}.', requiredProp, key)
								});
							} else {
								validationResult.propertiesValueMatches++;
							}
						});
					} else {
						let propertySchema = asSchema(propertyDep);
						if (propertySchema) {
							let propertyValidationResult = new ValidationResult();
							this.validate(propertySchema, propertyValidationResult, matchingSchemas);
							validationResult.mergePropertyMatch(propertyValidationResult);
						}
					}
				}
			});
		}

		let propertyNames = asSchema(schema.propertyNames);
		if (propertyNames) {
			this.properties.forEach(f => {
				let key = f.key;
				if (key) {
					key.validate(propertyNames, validationResult, NoOpSchemaCollector.instance);
				}
			});
		}
	}
}
//region
export function asSchema(schema: JSONSchemaRef) {
	if (typeof schema === 'boolean') {
		return schema ? {} : { "not": {} };
	}
	return schema;
}
//endregion

export interface JSONDocumentConfig {
	collectComments?: boolean;
}

export interface IApplicableSchema {
	node: ASTNode;
	inverted?: boolean;
	schema: JSONSchema;
}

export enum EnumMatch {
	Key, Enum
}

export interface ISchemaCollector {
	schemas: IApplicableSchema[];
	add(schema: IApplicableSchema): void;
	merge(other: ISchemaCollector): void;
	include(node: ASTNode): void;
	newSub(): ISchemaCollector;
}

class SchemaCollector implements ISchemaCollector {
	schemas: IApplicableSchema[] = [];
	constructor(private focusOffset = -1, private exclude: ASTNode = null) {
	}
	add(schema: IApplicableSchema) {
		this.schemas.push(schema);
	}
	merge(other: ISchemaCollector) {
		this.schemas.push(...other.schemas);
	}
	include(node: ASTNode) {
		return (this.focusOffset === -1 || node.contains(this.focusOffset)) && (node !== this.exclude);
	}
	newSub(): ISchemaCollector {
		return new SchemaCollector(-1, this.exclude);
	}
}

class NoOpSchemaCollector implements ISchemaCollector {
	private constructor() { }
	get schemas() { return []; }
	add(schema: IApplicableSchema) { }
	merge(other: ISchemaCollector) { }
	include(node: ASTNode) { return true; }
	newSub(): ISchemaCollector { return this; }

	static instance = new NoOpSchemaCollector();
}

export class ValidationResult {
	public problems: IProblem[];

	public propertiesMatches: number;
	public propertiesValueMatches: number;
	public primaryValueMatches: number;
	public enumValueMatch: boolean;
	public enumValues: any[];

	constructor() {
		this.problems = [];
		this.propertiesMatches = 0;
		this.propertiesValueMatches = 0;
		this.primaryValueMatches = 0;
		this.enumValueMatch = false;
		this.enumValues = null;
	}

	public hasProblems(): boolean {
		return !!this.problems.length;
	}

	public mergeAll(validationResults: ValidationResult[]): void {
		validationResults.forEach((validationResult) => {
			this.merge(validationResult);
		});
	}

	public merge(validationResult: ValidationResult): void {
		this.problems = this.problems.concat(validationResult.problems);
	}

	public mergeEnumValues(validationResult: ValidationResult): void {
		if (!this.enumValueMatch && !validationResult.enumValueMatch && this.enumValues && validationResult.enumValues) {
			this.enumValues = this.enumValues.concat(validationResult.enumValues);
			for (let error of this.problems) {
				if (error.code === ErrorCode.EnumValueMismatch) {
					error.message = localize('enumWarning', 'Value is not accepted. Valid values: {0}.', this.enumValues.map(v => JSON.stringify(v)).join(', '));
				}
			}
		}
	}

	public mergePropertyMatch(propertyValidationResult: ValidationResult): void {
		this.merge(propertyValidationResult);
		this.propertiesMatches++;
		if (propertyValidationResult.enumValueMatch || !propertyValidationResult.hasProblems() && propertyValidationResult.propertiesMatches) {
			this.propertiesValueMatches++;
		}
		if (propertyValidationResult.enumValueMatch && propertyValidationResult.enumValues && propertyValidationResult.enumValues.length === 1) {
			this.primaryValueMatches++;
		}
	}

	public compare(other: ValidationResult): number {
		let hasProblems = this.hasProblems();
		if (hasProblems !== other.hasProblems()) {
			return hasProblems ? -1 : 1;
		}
		if (this.enumValueMatch !== other.enumValueMatch) {
			return other.enumValueMatch ? -1 : 1;
		}
		if (this.primaryValueMatches !== other.primaryValueMatches) {
			return this.primaryValueMatches - other.primaryValueMatches;
		}
		if (this.propertiesValueMatches !== other.propertiesValueMatches) {
			return this.propertiesValueMatches - other.propertiesValueMatches;
		}
		return this.propertiesMatches - other.propertiesMatches;
	}

}

export class JSONDocument {

	constructor(public readonly root: ASTNode, public readonly syntaxErrors: IProblem[] = [], public readonly comments: IRange[] = []) {
	}

	public getNodeFromOffset(offset: number): ASTNode {
		return this.root && this.root.getNodeFromOffset(offset);
	}

	public getNodeFromOffsetEndInclusive(offset: number): ASTNode {
		return this.root && this.root.getNodeFromOffsetEndInclusive(offset);
	}

	public visit(visitor: (node: ASTNode) => boolean): void {
		if (this.root) {
			this.root.visit(visitor);
		}
	}

	public validate(schema: JSONSchema): IProblem[] {
		if (this.root && schema) {
			let validationResult = new ValidationResult();
			this.root.validate(schema, validationResult, NoOpSchemaCollector.instance);
			return validationResult.problems;
		}
		return null;
	}

	public getMatchingSchemas(schema: JSONSchema, focusOffset: number = -1, exclude: ASTNode = null): IApplicableSchema[] {
		let matchingSchemas = new SchemaCollector(focusOffset, exclude);
		if (this.root && schema) {
			this.root.validate(schema, new ValidationResult(), matchingSchemas);
		}
		return matchingSchemas.schemas;
	}
}

export function parse(textDocument: TextDocument, config?: JSONDocumentConfig): JSONDocument {

	let problems: IProblem[] = [];
	let text = textDocument.getText();
	let scanner = Json.createScanner(text, false);

	let comments = config && config.collectComments ? [] : void 0;

	function _scanNext(): Json.SyntaxKind {
		while (true) {
			let token = scanner.scan();
			_checkScanError();
			switch (token) {
				case Json.SyntaxKind.LineCommentTrivia:
				case Json.SyntaxKind.BlockCommentTrivia:
					if (Array.isArray(comments)) {
						comments.push({ start: scanner.getTokenOffset(), end: scanner.getTokenOffset() + scanner.getTokenLength() });
					}
					break;
				case Json.SyntaxKind.Trivia:
				case Json.SyntaxKind.LineBreakTrivia:
					break;
				default:
					return token;
			}
		}
	}

	function _accept(token: Json.SyntaxKind): boolean {
		if (scanner.getToken() === token) {
			_scanNext();
			return true;
		}
		return false;
	}

	function _errorAtRange<T extends ASTNode>(message: string, code: ErrorCode, location: IRange): void {
		if (problems.length === 0 || problems[problems.length - 1].location.start !== location.start) {
			problems.push({ message, location, code, severity: ProblemSeverity.Error });
		}
	}

	function _error<T extends ASTNode>(message: string, code: ErrorCode, node: T = null, skipUntilAfter: Json.SyntaxKind[] = [], skipUntil: Json.SyntaxKind[] = []): T {
		let start = scanner.getTokenOffset();
		let end = scanner.getTokenOffset() + scanner.getTokenLength();
		if (start === end && start > 0) {
			start--;
			while (start > 0 && /\s/.test(text.charAt(start))) {
				start--;
			}
			end = start + 1;
		}
		_errorAtRange(message, code, { start, end });

		if (node) {
			_finalize(node, false);
		}
		if (skipUntilAfter.length + skipUntil.length > 0) {
			let token = scanner.getToken();
			while (token !== Json.SyntaxKind.EOF) {
				if (skipUntilAfter.indexOf(token) !== -1) {
					_scanNext();
					break;
				} else if (skipUntil.indexOf(token) !== -1) {
					break;
				}
				token = _scanNext();
			}
		}
		return node;
	}

	function _checkScanError(): boolean {
		switch (scanner.getTokenError()) {
			case Json.ScanError.InvalidUnicode:
				_error(localize('InvalidUnicode', 'Invalid unicode sequence in string.'), ErrorCode.InvalidUnicode);
				return true;
			case Json.ScanError.InvalidEscapeCharacter:
				_error(localize('InvalidEscapeCharacter', 'Invalid escape character in string.'), ErrorCode.InvalidEscapeCharacter);
				return true;
			case Json.ScanError.UnexpectedEndOfNumber:
				_error(localize('UnexpectedEndOfNumber', 'Unexpected end of number.'), ErrorCode.UnexpectedEndOfNumber);
				return true;
			case Json.ScanError.UnexpectedEndOfComment:
				_error(localize('UnexpectedEndOfComment', 'Unexpected end of comment.'), ErrorCode.UnexpectedEndOfComment);
				return true;
			case Json.ScanError.UnexpectedEndOfString:
				_error(localize('UnexpectedEndOfString', 'Unexpected end of string.'), ErrorCode.UnexpectedEndOfString);
				return true;
			case Json.ScanError.InvalidCharacter:
				_error(localize('InvalidCharacter', 'Invalid characters in string. Control characters must be escaped.'), ErrorCode.InvalidCharacter);
				return true;
		}
		return false;
	}

	function _finalize<T extends ASTNode>(node: T, scanNext: boolean): T {
		node.end = scanner.getTokenOffset() + scanner.getTokenLength();

		if (scanNext) {
			_scanNext();
		}

		return node;
	}

	function _parseArray(parent: ASTNode, name: Json.Segment): ArrayASTNode {
		if (scanner.getToken() !== Json.SyntaxKind.OpenBracketToken) {
			return null;
		}
		let node = new ArrayASTNode(parent, name, scanner.getTokenOffset());
		_scanNext(); // consume OpenBracketToken

		let count = 0;
		let needsComma = false;
		while (scanner.getToken() !== Json.SyntaxKind.CloseBracketToken && scanner.getToken() !== Json.SyntaxKind.EOF) {
			if (scanner.getToken() === Json.SyntaxKind.CommaToken) {
				if (!needsComma) {
					_error(localize('ValueExpected', 'Value expected'), ErrorCode.ValueExpected);
				}
				let commaOffset = scanner.getTokenOffset();
				_scanNext(); // consume comma
				if (scanner.getToken() === Json.SyntaxKind.CloseBracketToken) {
					if (needsComma) {
						_errorAtRange(localize('TrailingComma', 'Trailing comma'), ErrorCode.TrailingComma, { start: commaOffset, end: commaOffset + 1 });
					}
					continue;
				}
			} else if (needsComma) {
				_error(localize('ExpectedComma', 'Expected comma'), ErrorCode.CommaExpected);
			}
			if (!node.addItem(_parseValue(node, count++))) {
				_error(localize('PropertyExpected', 'Value expected'), ErrorCode.ValueExpected, null, [], [Json.SyntaxKind.CloseBracketToken, Json.SyntaxKind.CommaToken]);
			}
			needsComma = true;
		}

		if (scanner.getToken() !== Json.SyntaxKind.CloseBracketToken) {
			return _error(localize('ExpectedCloseBracket', 'Expected comma or closing bracket'), ErrorCode.CommaOrCloseBacketExpected, node);
		}

		return _finalize(node, true);
	}

	function _parseProperty(parent: ObjectASTNode, keysSeen: any): PropertyASTNode {

		let key = _parseString(null, null, true);
		if (!key) {
			if (scanner.getToken() === Json.SyntaxKind.Unknown) {
				// give a more helpful error message
				_error(localize('DoubleQuotesExpected', 'Property keys must be doublequoted'), ErrorCode.Undefined);
				key = new StringASTNode(null, null, true, scanner.getTokenOffset(), scanner.getTokenOffset() + scanner.getTokenLength());
				key.value = scanner.getTokenValue();
				_scanNext(); // consume Unknown
			} else {
				return null;
			}
		}
		let node = new PropertyASTNode(parent, key);

		let seen = keysSeen[key.value];
		if (seen) {
			problems.push({ location: { start: node.key.start, end: node.key.end }, message: localize('DuplicateKeyWarning', "Duplicate object key"), code: ErrorCode.Undefined, severity: ProblemSeverity.Warning });
			if (seen instanceof PropertyASTNode) {
				problems.push({ location: { start: seen.key.start, end: seen.key.end }, message: localize('DuplicateKeyWarning', "Duplicate object key"), code: ErrorCode.Undefined, severity: ProblemSeverity.Warning });
			}
			keysSeen[key.value] = true; // if the same key is duplicate again, avoid duplicate error reporting
		} else {
			keysSeen[key.value] = node;
		}

		if (scanner.getToken() === Json.SyntaxKind.ColonToken) {
			node.colonOffset = scanner.getTokenOffset();
			_scanNext(); // consume ColonToken
		} else {
			_error(localize('ColonExpected', 'Colon expected'), ErrorCode.ColonExpected);
			if (scanner.getToken() === Json.SyntaxKind.StringLiteral && textDocument.positionAt(key.end).line < textDocument.positionAt(scanner.getTokenOffset()).line) {
				node.end = key.end;
				return node;
			}
		}

		if (!node.setValue(_parseValue(node, key.value))) {
			return _error(localize('ValueExpected', 'Value expected'), ErrorCode.ValueExpected, node, [], [Json.SyntaxKind.CloseBraceToken, Json.SyntaxKind.CommaToken]);
		}
		node.end = node.value.end;
		return node;
	}

	function _parseObject(parent: ASTNode, name: Json.Segment): ObjectASTNode {
		if (scanner.getToken() !== Json.SyntaxKind.OpenBraceToken) {
			return null;
		}
		let node = new ObjectASTNode(parent, name, scanner.getTokenOffset());
		let keysSeen: any = Object.create(null);
		_scanNext(); // consume OpenBraceToken
		let needsComma = false;

		while (scanner.getToken() !== Json.SyntaxKind.CloseBraceToken && scanner.getToken() !== Json.SyntaxKind.EOF) {
			if (scanner.getToken() === Json.SyntaxKind.CommaToken) {
				if (!needsComma) {
					_error(localize('PropertyExpected', 'Property expected'), ErrorCode.PropertyExpected);
				}
				let commaOffset = scanner.getTokenOffset();
				_scanNext(); // consume comma
				if (scanner.getToken() === Json.SyntaxKind.CloseBraceToken) {
					if (needsComma) {
						_errorAtRange(localize('TrailingComma', 'Trailing comma'), ErrorCode.TrailingComma, { start: commaOffset, end: commaOffset + 1 });
					}
					continue;
				}
			} else if (needsComma) {
				_error(localize('ExpectedComma', 'Expected comma'), ErrorCode.CommaExpected);
			}
			if (!node.addProperty(_parseProperty(node, keysSeen))) {
				_error(localize('PropertyExpected', 'Property expected'), ErrorCode.PropertyExpected, null, [], [Json.SyntaxKind.CloseBraceToken, Json.SyntaxKind.CommaToken]);
			}
			needsComma = true;
		}

		if (scanner.getToken() !== Json.SyntaxKind.CloseBraceToken) {
			return _error(localize('ExpectedCloseBrace', 'Expected comma or closing brace'), ErrorCode.CommaOrCloseBraceExpected, node);
		}
		return _finalize(node, true);
	}

	function _parseString(parent: ASTNode, name: Json.Segment, isKey: boolean): StringASTNode {
		if (scanner.getToken() !== Json.SyntaxKind.StringLiteral) {
			return null;
		}

		let node = new StringASTNode(parent, name, isKey, scanner.getTokenOffset());
		node.value = scanner.getTokenValue();

		return _finalize(node, true);
	}

	function _parseNumber(parent: ASTNode, name: Json.Segment): NumberASTNode {
		if (scanner.getToken() !== Json.SyntaxKind.NumericLiteral) {
			return null;
		}

		let node = new NumberASTNode(parent, name, scanner.getTokenOffset());
		if (scanner.getTokenError() === Json.ScanError.None) {
			let tokenValue = scanner.getTokenValue();
			try {
				let numberValue = JSON.parse(tokenValue);
				if (typeof numberValue !== 'number') {
					return _error(localize('InvalidNumberFormat', 'Invalid number format.'), ErrorCode.Undefined, node);
				}
				node.value = numberValue;
			} catch (e) {
				return _error(localize('InvalidNumberFormat', 'Invalid number format.'), ErrorCode.Undefined, node);
			}
			node.isInteger = tokenValue.indexOf('.') === -1;
		}
		return _finalize(node, true);
	}

	function _parseLiteral(parent: ASTNode, name: Json.Segment): ASTNode {
		let node: ASTNode;
		switch (scanner.getToken()) {
			case Json.SyntaxKind.NullKeyword:
				node = new NullASTNode(parent, name, scanner.getTokenOffset());
				break;
			case Json.SyntaxKind.TrueKeyword:
				node = new BooleanASTNode(parent, name, true, scanner.getTokenOffset());
				break;
			case Json.SyntaxKind.FalseKeyword:
				node = new BooleanASTNode(parent, name, false, scanner.getTokenOffset());
				break;
			default:
				return null;
		}
		return _finalize(node, true);
	}

	function _parseValue(parent: ASTNode, name: Json.Segment): ASTNode {
		return _parseArray(parent, name) || _parseObject(parent, name) || _parseString(parent, name, false) || _parseNumber(parent, name) || _parseLiteral(parent, name);
	}

	let _root = null;
	let token = _scanNext();
	if (token !== Json.SyntaxKind.EOF) {
		_root = _parseValue(null, null);
		if (!_root) {
			_error(localize('Invalid symbol', 'Expected a JSON object, array or literal.'), ErrorCode.Undefined);
		} else if (scanner.getToken() !== Json.SyntaxKind.EOF) {
			_error(localize('End of file expected', 'End of file expected.'), ErrorCode.Undefined);
		}
	}
	return new JSONDocument(_root, problems, comments);
}
