// TypeScript checker types → IR types (docs/design/M2-VALUES.md, D16).
import ts from 'typescript';
import type { RecordType, Type } from './ir.ts';
import { maybeInner } from './irtype.ts';

export type Fail = (node: ts.Node, code: string, message: string) => never;

export class TypeMapper {
  readonly records: RecordType[] = [];
  private byType = new Map<ts.Type, number>();
  private byShape = new Map<string, number>();

  private checker: ts.TypeChecker;
  private fail: Fail;
  /**
   * The IR type of a class instance type (set by the class lowering): its
   * record, or a class reference when the class has subclasses.
   */
  classType?: (cls: ts.Symbol, t: ts.Type, at: ts.Node) => Type;
  /** The IR type of a union of class instance types (a class reference). */
  classUnion?: (parts: ts.Type[], at: ts.Node) => Type;
  /** The IR type a mapping pack gives a package type (frontend/packs.ts), if any. */
  packType?: (t: ts.Type, at: ts.Node) => Type | undefined;
  /** The record of MutationObservers, once a program uses one. */
  mutationObserver?: number;
  /**
   * Records of types a package's declaration files declare (interfaces of
   * options objects): literals may list their properties in any order, so
   * their key order is not tracked (key-observing built-ins reject them).
   */
  readonly packageRecords = new Set<number>();
  /** The record of image objects (frontend/dom.d.ts), once used. */
  image: number | undefined;

  constructor(checker: ts.TypeChecker, fail: Fail) {
    this.checker = checker;
    this.fail = fail;
  }

  /** The IR type of the value of `node`. */
  private overrides = new Map<ts.Symbol, Type>();

  /** Give a symbol an IR type that TypeScript does not know (e.g. catch bindings). */
  override(symbol: ts.Symbol, type: Type) {
    this.overrides.set(symbol, type);
  }

  of(node: ts.Node): Type {
    const o = this.overridden(node);
    if (o) return o;
    return this.map(this.checker.getTypeAtLocation(node), node);
  }

  /** Like `of`, but undefined instead of failing on any/unknown. */
  typeOrUndefined(node: ts.Node): Type | undefined {
    const o = this.overridden(node);
    if (o) return o;
    const t = this.checker.getTypeAtLocation(node);
    if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return undefined;
    return this.map(t, node);
  }

  /** The type given to `node` instead of TypeScript's, if any. */
  overridden(node: ts.Node): Type | undefined {
    if (ts.isIdentifier(node)) {
      const s = this.checker.getSymbolAtLocation(node);
      return s && this.overrides.get(s);
    }
    // `e.message` on an overridden record.
    if (ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression)) {
      const base = this.overridden(node.expression);
      if (typeof base === 'object' && 'record' in base) {
        const field = this.records[base.record].fields.find(f => f.name === node.name.text);
        if (field) return field.type;
      }
    }
    return undefined;
  }

  /**
   * Like `map`, but undefined where `map` would fail; records registered on
   * the way to the failure are dropped again.
   */
  tryMap(t: ts.Type, at: ts.Node): Type | undefined {
    const records = this.records.length;
    const byType = new Map(this.byType);
    const byShape = new Map(this.byShape);
    const fail = this.fail;
    const sentinel = new Error('unmappable');
    this.fail = () => {
      throw sentinel;
    };
    try {
      return this.map(t, at);
    } catch (e) {
      if (e !== sentinel) throw e;
      this.records.length = records;
      this.byType = byType;
      this.byShape = byShape;
      return undefined;
    } finally {
      this.fail = fail;
    }
  }

  map(t: ts.Type, at: ts.Node): Type {
    const F = ts.TypeFlags;
    // `this` in a class member: the class instance.
    if (t.flags & F.TypeParameter && (t as { isThisType?: boolean }).isThisType) {
      const c = this.checker.getBaseConstraintOfType(t);
      if (c && c !== t) return this.map(c, at);
    }
    if (t.flags & (F.Number | F.NumberLiteral)) return 'number';
    if (t.flags & (F.String | F.StringLiteral | F.TemplateLiteral)) return 'string';
    if (t.flags & (F.Boolean | F.BooleanLiteral)) return 'boolean';
    if (t.flags & (F.Void | F.Undefined)) return 'void';
    if (t.flags & F.EnumLiteral && t.isUnion()) return this.map(t.types[0], at);
    if (t.isUnion()) return this.union(t.types, at);
    if (t.flags & (F.Any | F.Unknown))
      this.fail(
        at,
        'E_TYPE_UNSUPPORTED',
        'Values of type any/unknown need a static type (or a JS island, M6)',
      );
    if (t.flags & F.Null)
      this.fail(at, 'E_TYPE_UNSUPPORTED', 'A value that is always null has no useful type');
    if (t.flags & F.Never)
      this.fail(
        at,
        'E_TYPE_UNSUPPORTED',
        'This value has type never; add a type annotation (e.g. an empty array needs its element type)',
      );
    if (t.flags & (F.BigInt | F.BigIntLiteral | F.ESSymbol | F.UniqueESSymbol))
      this.fail(
        at,
        'E_TYPE_UNSUPPORTED',
        'bigint and symbol values are outside the supported value model',
      );
    // Types a mapping pack represents (svelte-toolbelt's boxes).
    if (t.flags & (F.Object | F.Intersection)) {
      const packed = this.packType?.(t, at);
      if (packed) return packed;
    }
    if (t.flags & F.Object) return this.object(t as ts.ObjectType, at);
    // An intersection of object types (`Props & { props: … }`) is the record of their properties.
    if (t.flags & F.Intersection) {
      // A DOM handle refined by an intersection (bits-ui's `MouseEvent & { currentTarget: … }`).
      if (t.getProperty('__runicElement')) return 'element';
      if (t.getProperty('__runicEvent')) return 'event';
      const attrs = (t as ts.IntersectionType).types.some(p => p.getProperty('__runicAttrs'));
      return attrs ? 'attrs' : { record: this.record(t, at) };
    }
    return this.fail(at, 'E_TYPE_UNSUPPORTED', `Unsupported type ${this.checker.typeToString(t)}`);
  }

  private union(parts: ts.Type[], at: ts.Node): Type {
    const F = ts.TypeFlags;
    const nullish = parts.filter(p => p.flags & (F.Null | F.Undefined | F.Void));
    const rest = parts.filter(p => !(p.flags & (F.Null | F.Undefined | F.Void)));
    let base: Type;
    if (rest.length === 0) return 'void';
    if (rest.every(p => p.flags & (F.Boolean | F.BooleanLiteral))) base = 'boolean';
    else if (rest.every(p => p.flags & (F.String | F.StringLiteral | F.TemplateLiteral)))
      base = 'string';
    else if (rest.every(p => p.flags & (F.Number | F.NumberLiteral))) base = 'number';
    else if (rest.length === 1) base = this.map(rest[0], at);
    else if (this.classUnion && rest.every(p => this.sourceClass(p)))
      base = this.classUnion(rest, at);
    else if (rest.every(p => this.plainObject(p)) && this.mergeable(rest, at))
      base = { record: this.unionRecord(rest, at) };
    else {
      const mapped = rest.map(p => this.map(p, at));
      const first = JSON.stringify(mapped[0]);
      if (mapped.every(m => JSON.stringify(m) === first)) base = mapped[0];
      else
        return this.fail(
          at,
          'E_TYPE_UNION',
          `Union ${rest.map(p => this.checker.typeToString(p)).join(' | ')} is outside the value model (M2 supports nullable types and literal unions)`,
        );
    }
    return nullish.length ? { maybe: base } : base;
  }

  private object(t: ts.ObjectType, at: ts.Node): Type {
    // A module namespace object (`import * as ns`).
    const decl = t.symbol?.valueDeclaration;
    if (decl && ts.isSourceFile(decl))
      this.fail(
        at,
        'E_IMPORT',
        'A module namespace is not a value: namespaces are supported as component tags (<Ns.Name>) and re-exports; import the names the code uses',
      );
    // DOM elements (frontend/dom.d.ts) are opaque handles.
    if (t.getProperty('__runicElement')) return 'element';
    // Event objects (frontend/dom.d.ts) are opaque values read through built-ins.
    if (t.getProperty('__runicEvent')) return 'event';
    if (t.getProperty('__runicMediaQuery')) return 'media-query';
    // An image object (frontend/dom.d.ts): a record of its properties.
    if (t.getProperty('__runicImage')) {
      if (this.image === undefined) {
        this.image = this.records.length;
        const handler: Type = { maybe: { fn: { params: [], result: 'void' } } };
        this.records.push({
          name: 'Image',
          class: true,
          fields: [
            { name: 'src', type: 'string' },
            { name: 'crossOrigin', type: { maybe: 'string' } },
            { name: 'referrerPolicy', type: 'string' },
            { name: 'onload', type: handler },
            { name: 'onerror', type: handler },
          ],
        });
      }
      return { record: this.image };
    }
    // A computed style declaration stands for its element (frontend/dom.d.ts).
    if (t.getProperty('__runicComputedStyle')) return 'element';
    // Attribute bags (docs/IR.md `attrs`): the marker frontend/dom.d.ts
    // declares for bag-building object literals, and objects of untyped
    // entries only: `Record<string, unknown>` (the props bits-ui passes to
    // `child` snippets) and symbol-keyed attachment objects (svelte-toolbelt's
    // `attachRef`).
    if (t.getProperty('__runicAttrs')) return 'attrs';
    // A MutationObserver (frontend/dom.d.ts): a record holding its callback.
    if (t.getProperty('__runicMutationObserver')) {
      if (this.mutationObserver === undefined) {
        this.mutationObserver = this.records.length;
        this.records.push({
          name: 'MutationObserver',
          class: true,
          fields: [{ name: 'callback', type: { fn: { params: [], result: 'void' } } }],
        });
      }
      return { record: this.mutationObserver };
    }
    if (!this.checker.getPropertiesOfType(t).length && !t.getCallSignatures().length) {
      const infos = this.checker.getIndexInfosOfType(t);
      if (
        infos.length &&
        infos.every(
          i =>
            !!(i.keyType.flags & ts.TypeFlags.ESSymbolLike) ||
            !!(i.type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any)),
        )
      )
        return 'attrs';
    }
    // An object used as a dictionary of one value type (bits-ui's
    // `keyToIndex = { [nextKey]: …, [kbd.HOME]: 0 }`): a string index
    // signature, and properties (constant keys) of its value type. A map
    // from string keys, only reached by element access (language.ts guards
    // the names of Object.prototype's members).
    if (!t.getCallSignatures().length) {
      const infos = this.checker.getIndexInfosOfType(t);
      const strings = infos.find(i => i.keyType.flags & ts.TypeFlags.String);
      if (
        infos.length === 1 &&
        strings &&
        !(strings.type.flags & (ts.TypeFlags.Unknown | ts.TypeFlags.Any))
      ) {
        const value = this.map(strings.type, at);
        const props = this.checker.getPropertiesOfType(t);
        if (
          props.every(
            p =>
              JSON.stringify(this.tryMap(this.checker.getTypeOfSymbolAtLocation(p, at), at)) ===
              JSON.stringify(value),
          )
        )
          return { map: ['string', value] };
      }
    }
    const name = t.symbol?.name ?? t.aliasSymbol?.name;
    const args = (t as ts.TypeReference).target
      ? this.checker.getTypeArguments(t as ts.TypeReference)
      : [];
    if (this.checker.isArrayType(t) || this.checker.isTupleType(t)) {
      if (this.checker.isTupleType(t)) {
        const items = args.map(a => this.map(a, at));
        const first = JSON.stringify(items[0]);
        if (!items.every(i => JSON.stringify(i) === first))
          this.fail(at, 'E_TYPE_UNSUPPORTED', 'Heterogeneous tuples are outside the value model');
        return { array: items[0] ?? 'number' };
      }
      return { array: this.map(args[0], at) };
    }
    if ((name === 'Map' || name === 'ReadonlyMap') && args.length === 2)
      return { map: [this.map(args[0], at), this.map(args[1], at)] };
    if ((name === 'Set' || name === 'ReadonlySet') && args.length === 1)
      return { set: this.map(args[0], at) };
    const calls = t.getCallSignatures();
    if (calls.length) {
      if (calls.length > 1)
        this.fail(at, 'E_TYPE_UNSUPPORTED', 'Overloaded function values are unsupported');
      const sig = calls[0];
      return {
        fn: {
          params: sig.parameters.map(p =>
            this.map(this.checker.getTypeOfSymbolAtLocation(p, at), at),
          ),
          result: this.map(sig.getReturnType(), at),
        },
      };
    }
    if (name === 'Promise') {
      const [arg] = this.checker.getTypeArguments(t as ts.TypeReference);
      // Promise<never> (Promise.reject) never fulfils: Promise<void>.
      const inner = arg && !(arg.flags & ts.TypeFlags.Never) ? this.map(arg, at) : 'void';
      if (typeof inner === 'object' && 'promise' in inner)
        this.fail(at, 'E_TYPE_UNSUPPORTED', 'Promises of promises are unsupported');
      return { promise: inner };
    }
    // Regular expressions (docs/IR.md): RegExp objects, and match arrays as
    // arrays of strings (frontend/language.ts types captures that may not
    // participate as `string | undefined` from the pattern).
    if (name === 'RegExp' && this.fromLib(t)) return 'regexp';
    if ((name === 'RegExpExecArray' || name === 'RegExpMatchArray') && this.fromLib(t))
      return { array: 'string' };
    if (
      name === 'RegExpStringIterator' ||
      (name === 'IterableIterator' &&
        args.some(a => /^RegExp(Exec|Match)Array$/.test(a.symbol?.name ?? '')))
    )
      this.fail(
        at,
        'E_REGEXP',
        'matchAll results are supported directly in for-of, Array.from(…) and [...…]',
      );
    // Dates (docs/IR.md): Date objects with a mutable time value.
    if (name === 'Date' && this.fromLib(t)) return 'date';
    // Intl formatters are compile-time constants (frontend/intl.ts), not values.
    if (
      name &&
      ['DateTimeFormat', 'NumberFormat', 'Collator', 'PluralRules', 'DisplayNames'].includes(
        name,
      ) &&
      this.fromLib(t)
    )
      this.fail(
        at,
        'E_INTL',
        `Intl.${name} objects are supported as constants used through their methods (const f = new Intl.DateTimeFormat(…); f.format(d)), not as values`,
      );
    if (name && ['Error', 'HTMLElement'].includes(name))
      this.fail(at, 'E_TYPE_UNSUPPORTED', `${name} values are planned for a later milestone`);
    // Class instances are nominal records (frontend/classes.ts).
    const cls = t.symbol && t.symbol.flags & ts.SymbolFlags.Class ? t.symbol : undefined;
    if (cls && !this.fromLib(t)) {
      if (t.getConstructSignatures().length)
        this.fail(
          at,
          'E_CLASS',
          `The class ${cls.name} is not a value (construct it with new, or use its static members)`,
        );
      if (!this.classType)
        this.fail(at, 'E_CLASS', `Class ${cls.name} instances are unsupported here`);
      return this.classType!(cls, t, at);
    }
    return { record: this.record(t, at) };
  }

  /** Whether `t` is the instance type of a class compiled from source. */
  private sourceClass(t: ts.Type): boolean {
    return (
      !!(t.flags & ts.TypeFlags.Object) &&
      !!t.symbol &&
      !!(t.symbol.flags & ts.SymbolFlags.Class) &&
      !t.getConstructSignatures().length &&
      !this.fromLib(t)
    );
  }

  /** Whether `t` is declared by TypeScript's standard library. */
  private fromLib(t: ts.Type): boolean {
    const file = t.symbol?.declarations?.[0]?.getSourceFile();
    return !!file && /[\\/]lib\.[\w.]*\.d\.ts$/.test(file.fileName);
  }

  private record(t: ts.Type, at: ts.Node): number {
    const known = this.byType.get(t);
    if (known !== undefined) return known;
    const index = this.records.length;
    // Register before mapping fields so recursive types terminate.
    this.byType.set(t, index);
    const placeholder: RecordType = {
      name: t.symbol?.name && t.symbol.name !== '__object' ? t.symbol.name : 'Object',
      fields: [],
    };
    this.records.push(placeholder);
    for (const p of this.checker.getPropertiesOfType(t)) {
      const decl = p.valueDeclaration ?? p.declarations?.[0];
      let pt = this.checker.getTypeOfSymbolAtLocation(p, decl ?? at);
      if (p.flags & ts.SymbolFlags.Optional)
        pt = this.checker.getNullableType(pt, ts.TypeFlags.Undefined);
      // Properties a package's declaration files declare are reported where
      // the program uses the type.
      const where =
        decl &&
        !(
          decl.getSourceFile().isDeclarationFile &&
          /[\\/]node_modules[\\/]/.test(decl.getSourceFile().fileName)
        )
          ? decl
          : at;
      placeholder.fields.push({ name: p.name, type: this.map(pt, where) });
    }
    // An object literal's keys are in JavaScript order (TypeScript orders
    // spread types differently).
    const literal = t.symbol?.declarations?.[0];
    if (literal && ts.isObjectLiteralExpression(literal)) {
      const order = this.keyOrder(literal, placeholder.fields);
      placeholder.fields.sort((a, b) => order.indexOf(a.name) - order.indexOf(b.name));
    }
    // (An intersection, such as bits-ui's snippet props, by its members.)
    const declarations =
      (t.aliasSymbol ?? t.symbol)?.declarations ??
      (t.isIntersection() && t.types.every(m => (m.aliasSymbol ?? m.symbol)?.declarations?.length)
        ? t.types.flatMap(m => (m.aliasSymbol ?? m.symbol)!.declarations!)
        : []);
    if (
      declarations.length &&
      declarations.every(
        d =>
          d.getSourceFile().isDeclarationFile &&
          /[\\/]node_modules[\\/]/.test(d.getSourceFile().fileName),
      )
    )
      this.packageRecords.add(index);
    // Structurally identical records share one IR record.
    const shape = JSON.stringify(placeholder.fields);
    const same = this.byShape.get(shape);
    const last = index === this.records.length - 1;
    if (same !== undefined && same !== index && last && !this.referencesSelf(placeholder, index)) {
      this.records.pop();
      this.byType.set(t, same);
      return same;
    }
    this.byShape.set(shape, index);
    return index;
  }

  /** Whether `t` is a plain object type (a record), not a DOM handle, bag, class or pack type. */
  private plainObject(t: ts.Type): boolean {
    if (!(t.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection))) return false;
    if (t.getCallSignatures().length || t.getConstructSignatures().length) return false;
    if (this.sourceClass(t)) return false;
    if (t.isIntersection() && !t.types.every(m => m.flags & ts.TypeFlags.Object)) return false;
    const markers = ['__runicElement', '__runicEvent', '__runicMediaQuery', '__runicAttrs'];
    if (markers.some(m => t.getProperty(m))) return false;
    if (this.checker.isArrayType(t) || this.checker.isTupleType(t)) return false;
    const s = t.symbol?.name;
    return !(s && ['Map', 'Set', 'Promise', 'Date', 'RegExp', 'Array'].includes(s));
  }

  /** The member types of property `name` of each union member (undefined where absent or optional). */
  private memberTypes(parts: ts.Type[], name: string, at: ts.Node): (ts.Type | undefined)[] {
    return parts.flatMap(m => {
      const p = this.checker.getPropertyOfType(m, name);
      if (!p) return [undefined];
      const t = this.checker.getTypeOfSymbolAtLocation(p, p.valueDeclaration ?? at);
      return p.flags & ts.SymbolFlags.Optional ? [t, undefined] : [t];
    });
  }

  /** The property names of union members, in member order. */
  private unionNames(parts: ts.Type[]): string[] {
    const names: string[] = [];
    for (const m of parts)
      for (const p of this.checker.getPropertiesOfType(m))
        if (!names.includes(p.name)) names.push(p.name);
    return names;
  }

  /**
   * Whether a union of plain object types can be one record: each property
   * has one IR type in every member that has it (nullable where a member
   * lacks it or makes it optional).
   */
  private mergeable(parts: ts.Type[], at: ts.Node): boolean {
    return this.unionNames(parts).every(name => {
      const types = this.memberTypes(parts, name, at).filter(t => t !== undefined);
      const mapped = types.map(t => {
        const F = ts.TypeFlags;
        if (t.flags & (F.Undefined | F.Void | F.Null)) return 'nullish';
        const m = this.tryMap(t, at);
        return m === undefined ? undefined : JSON.stringify(maybeInner(m) ?? m);
      });
      if (mapped.includes(undefined)) return false;
      const bases = new Set(mapped.filter(m => m !== 'nullish'));
      return bases.size === 1;
    });
  }

  /**
   * A union of plain object types (svelte-toolbelt's and bits-ui's options,
   * `{ candidateAttr: string } | { candidateSelector: string }` and the
   * like) as one record: each property with its one type, nullable where a
   * member lacks it or makes it optional. Which member a value belongs to is
   * not kept: its key set is not tracked, so key-observing built-ins reject
   * the record (`packageRecords`).
   */
  private unionRecord(parts: ts.Type[], at: ts.Node): number {
    const fields: { name: string; type: Type }[] = [];
    for (const name of this.unionNames(parts)) {
      const types = this.memberTypes(parts, name, at);
      const nullable = types.some(
        t =>
          t === undefined ||
          t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null),
      );
      const present = types.find(
        t =>
          t !== undefined &&
          !(t.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Void | ts.TypeFlags.Null)),
      )!;
      const m = this.map(present, at);
      const inner = maybeInner(m) ?? m;
      fields.push({ name, type: nullable || maybeInner(m) ? { maybe: inner } : inner });
    }
    const shape = JSON.stringify(fields);
    const same = this.byShape.get(shape);
    if (same !== undefined && this.packageRecords.has(same)) return same;
    const index = this.records.length;
    this.records.push({ name: 'Object', fields });
    this.byShape.set(shape, index);
    this.packageRecords.add(index);
    return index;
  }

  private referencesSelf(r: RecordType, index: number): boolean {
    return JSON.stringify(r.fields).includes(`{"record":${index}}`);
  }

  /**
   * The key order of an object literal with `fields`: its own keys in order,
   * where a spread contributes its source's keys; other fields follow.
   */
  keyOrder(e: ts.ObjectLiteralExpression, fields: { name: string }[]): string[] {
    const order: string[] = [];
    for (const p of e.properties) {
      let names: string[] = [];
      if (ts.isSpreadAssignment(p)) {
        const st = this.of(p.expression);
        if (typeof st === 'object' && 'record' in st)
          names = this.records[st.record].fields.map(f => f.name);
      } else if (p.name && (ts.isIdentifier(p.name) || ts.isStringLiteral(p.name)))
        names = [p.name.text];
      for (const n of names)
        if (!order.includes(n) && fields.some(f => f.name === n)) order.push(n);
    }
    for (const f of fields) if (!order.includes(f.name)) order.push(f.name);
    return order;
  }

  /** The record with `record`'s fields in the order of `names` (shared by shape). */
  reordered(record: number, names: string[]): number {
    const r = this.records[record];
    const fields = names.map(n => r.fields.find(f => f.name === n)!);
    const shape = JSON.stringify(fields);
    const same = this.byShape.get(shape);
    if (same !== undefined) return same;
    this.records.push({ name: r.name, fields });
    this.byShape.set(shape, this.records.length - 1);
    return this.records.length - 1;
  }

  fieldIndex(record: number, name: string, at: ts.Node): number {
    const i = this.records[record].fields.findIndex(f => f.name === name);
    if (i < 0) this.fail(at, 'E_FIELD', `Record ${this.records[record].name} has no field ${name}`);
    return i;
  }
}

export const sameType = (a: Type, b: Type) => JSON.stringify(a) === JSON.stringify(b);
