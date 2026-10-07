// TypeScript checker types → IR types (docs/design/M2-VALUES.md, D16).
import ts from 'typescript';
import type { RecordField, RecordType, Type } from './ir.ts';
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
  /**
   * The IR type a type parameter is bound to (a generic class's one
   * instantiation, frontend/classes.ts), if any.
   */
  typeParameter?: (t: ts.Type) => Type | undefined;
  /**
   * Types whose records are not cached by TypeScript type: they use type
   * parameters of a generic function specialisation being lowered.
   */
  uncached?: (t: ts.Type) => boolean;
  /** Whether a parameter is the document or the window (no IR parameter, `Lowerer.hostParam`). */
  hostParameter?: (p: ts.ParameterDeclaration) => boolean;
  /** The IR type a mapping pack gives a package type (frontend/packs.ts), if any. */
  packType?: (t: ts.Type, at: ts.Node) => Type | undefined;
  /** The record of Error values (`{ name, message }`), from the language layer. */
  errorType?: () => number;
  /**
   * The member a union outside the value model is narrowed to by the values
   * that reach it (frontend/unions.ts), or a failure through `fail`.
   */
  narrow?: (parts: ts.Type[], at: ts.Node, fail: Fail) => ts.Type;
  /**
   * Whether only null and undefined reach the property declared by `decl`,
   * which TypeScript types `unknown` (frontend/unions.ts).
   */
  nothingSlot?: (decl: ts.Declaration) => boolean;
  /** The same for the `current` of the boxes a property holds. */
  nothingInBoxes?: (decl: ts.Declaration) => boolean;
  /**
   * The type of the functions given to the property declared by `decl`,
   * typed as any function (`(...args: any[]) => any`), where they all have
   * one type (frontend/unions.ts).
   */
  anyFnSlot?: (decl: ts.Declaration, box?: boolean) => ts.Type | undefined;
  /** While a box property holding nothing is mapped: its `unknown` content. */
  private boxNothing = false;
  /** The record of MutationObservers, once a program uses one. */
  mutationObserver?: number;
  /** The record of ResizeObservers (M6), once a program uses one. */
  resizeObserver?: number;
  /** The IntersectionObserver record (frontend/dom.d.ts), once mapped. */
  intersectionObserver?: number;
  /**
   * Records of types a package's declaration files declare (interfaces of
   * options objects): literals may list their properties in any order, so
   * their key order is not tracked (key-observing built-ins reject them).
   */
  readonly packageRecords = new Set<number>();
  /**
   * Records `mergeRecords` made: a field's type is the union of the merged
   * types', so a read is narrowed to TypeScript's type where it is used.
   */
  readonly merged = new Set<number>();
  /**
   * Object types some literal of the program implements with getters
   * (shadcn-svelte's `setToggleGroupCtx({ get variant() { … } })`), filled
   * by the language layer: their records hold a getter per property, which
   * every read calls (`accessors`).
   */
  readonly accessorTypes = new Set<ts.Type>();
  /** Records of `accessorTypes`: fields are getters (`() => T`). */
  readonly accessors = new Set<number>();
  /** The record of image objects (frontend/dom.d.ts), once used. */
  image: number | undefined;

  /**
   * Dynamic values (M6 spike, runic.json `"dynamicValues": true`): a value
   * whose type is outside the static model (`any`, `unknown`, a union the
   * model has no member for) is `dyn` instead of a diagnostic. Only as the
   * last resort: `tryMap` (which every inference uses to look for a static
   * type) still gives undefined for them.
   */
  dynamic = false;
  /** Nesting of `tryMap` calls (dynamic values are not given inside them). */
  private trying = 0;

  /** Whether `t` maps to a dynamic value (the last-resort mapping, not `tryMap`'s). */
  mapsToDyn(t: ts.Type, at: ts.Node): boolean {
    if (!this.dynamic) return false;
    const fail = this.fail;
    const sentinel = new Error('no type');
    this.fail = () => {
      throw sentinel;
    };
    try {
      return this.map(t, at) === 'dyn';
    } catch (e) {
      if (e !== sentinel) throw e;
      return false;
    } finally {
      this.fail = fail;
    }
  }

  /** Whether an unmappable type becomes `dyn` here. */
  private dynHere(): boolean {
    return this.dynamic && this.trying === 0;
  }

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
    return this.map(this.givenFunction(node) ?? this.checker.getTypeAtLocation(node), node);
  }

  /**
   * Like `of`, but undefined instead of failing on any/unknown, also where
   * they are part of the type (`ReadableBox<any>` in untyped JavaScript).
   */
  typeOrUndefined(node: ts.Node): Type | undefined {
    const o = this.overridden(node);
    if (o) return o;
    const t = this.givenFunction(node) ?? this.checker.getTypeAtLocation(node);
    // (A value TypeScript types as only null says nothing about its IR type.)
    // (Nor does `never`: a narrowing of such a value, `simpleBox(null).current`.)
    if (
      t.flags &
      (ts.TypeFlags.Any | ts.TypeFlags.Unknown | ts.TypeFlags.Null | ts.TypeFlags.Never)
    )
      return undefined;
    const mapped = this.tryMap(t, node);
    if (mapped !== undefined) return mapped;
    if (containsAny(t, this.checker, 0, true)) return undefined;
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
    this.trying++;
    try {
      return this.map(t, at);
    } catch (e) {
      if (e !== sentinel) throw e;
      this.records.length = records;
      this.byType = byType;
      this.byShape = byShape;
      return undefined;
    } finally {
      this.trying--;
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
    if (t.flags & F.TypeParameter) {
      const bound = this.typeParameter?.(t);
      if (bound !== undefined) return bound;
    }
    // `ReturnType<F>` of a type parameter bound to a function type (a
    // generic class's one instantiation; bits-ui's `SharedState.get`):
    // TypeScript leaves it deferred, its result is the function's.
    const [f] = t.aliasTypeArguments ?? [];
    if (
      t.flags & F.Conditional &&
      t.aliasSymbol?.name === 'ReturnType' &&
      /[\\/]lib\.[\w.]*\.d\.ts$/.test(
        t.aliasSymbol.declarations?.[0]?.getSourceFile().fileName ?? '',
      ) &&
      f &&
      f.flags & F.TypeParameter &&
      this.typeParameter?.(f)
    ) {
      const fn = this.map(f, at);
      if (typeof fn === 'object' && 'fn' in fn) return fn.fn.result;
    }
    if (t.flags & (F.Number | F.NumberLiteral)) return 'number';
    if (t.flags & (F.String | F.StringLiteral | F.TemplateLiteral)) return 'string';
    if (t.flags & (F.Boolean | F.BooleanLiteral)) return 'boolean';
    if (t.flags & (F.Void | F.Undefined)) return 'void';
    if (t.flags & F.EnumLiteral && t.isUnion()) return this.map(t.types[0], at);
    if (t.isUnion()) {
      // A union containing itself (`ClassValue = … | ClassValue[]`) is outside the value model.
      // (A nullable object type reached again through its own fields, such
      // as bits-ui's `root: TooltipRootState | null` of the tether its root
      // refers to, ends at the type's record, registered before its fields.)
      const objects = t.types.filter(p => !(p.flags & (F.Null | F.Undefined | F.Void)));
      const nullableObject = objects.length === 1 && !!(objects[0].flags & F.Object);
      if (this.unions.has(t) && !nullableObject)
        return this.fail(
          at,
          'E_TYPE_UNION',
          `Recursive union ${this.checker.typeToString(t)} is outside the value model`,
        );
      this.unions.add(t);
      try {
        // (A union outside the static model, with dynamic values: `dyn`,
        // which holds null and undefined too.)
        if (this.dynHere()) {
          const fail = this.fail;
          const sentinel = new Error('union');
          this.fail = () => {
            throw sentinel;
          };
          try {
            return this.union(t.types, at);
          } catch (e) {
            if (e !== sentinel) throw e;
            return 'dyn';
          } finally {
            this.fail = fail;
          }
        }
        return this.union(t.types, at);
      } finally {
        this.unions.delete(t);
      }
    }
    if (t.flags & F.Unknown && this.boxNothing) return { maybe: 'void' };
    if (t.flags & (F.Any | F.Unknown) && this.dynHere()) return 'dyn';
    if (t.flags & (F.Any | F.Unknown))
      this.fail(
        at,
        'E_TYPE_UNSUPPORTED',
        'Values of type any/unknown need a static type (or a JS island, M6)',
      );
    if (t.flags & F.Null)
      this.fail(at, 'E_TYPE_UNSUPPORTED', 'A value that is always null has no useful type');
    // (An empty array's items, with dynamic values: dynamic.)
    if (t.flags & F.Never && this.dynHere()) return 'dyn';
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
    // A style object typed by csstype (bits-ui's and svelte-toolbelt's
    // `StyleProperties = CSS.Properties & { [str: \`--${string}\`]: any }`): a
    // dictionary of property names (camelCase or custom) and values, in
    // insertion order, a value of another type converted to a string where
    // it is given (style objects only ever print their values).
    if (t.flags & F.Intersection && (t as ts.IntersectionType).types.some(cssType))
      return { map: ['string', { maybe: 'string' }] };
    // An intersection of object types (`Props & { props: … }`) is the record of their properties.
    if (t.flags & F.Intersection) {
      // A DOM handle refined by an intersection (bits-ui's `MouseEvent & { currentTarget: … }`).
      if (t.getProperty('__runicElement')) return 'element';
      if (t.getProperty('__runicEvent')) return 'event';
      const attrs = (t as ts.IntersectionType).types.some(p => p.getProperty('__runicAttrs'));
      if (attrs) return 'attrs';
      // Functions intersected (mergeProps' `((e: E) => void) &
      // PointerEventHandler<…>` of merged handlers): the first, where the
      // others take the same parameters and give the same result or `any`
      // (calls resolve to the first signature).
      const parts = (t as ts.IntersectionType).types;
      if (
        parts.every(
          p => p.getCallSignatures().length === 1 && !this.checker.getPropertiesOfType(p).length,
        )
      ) {
        const first = this.map(parts[0], at);
        const fnOf = (x: Type | undefined) =>
          typeof x === 'object' && x !== null && 'fn' in x ? x.fn : undefined;
        const f = fnOf(first);
        const compatible = parts.slice(1).every(p => {
          const sig = p.getCallSignatures()[0];
          const params = sig.parameters.map(q => this.tryMap(this.checker.getTypeOfSymbol(q), at));
          const result = sig.getReturnType();
          return (
            !!f &&
            params.length === f.params.length &&
            params.every(
              (q, i) => q !== undefined && JSON.stringify(q) === JSON.stringify(f.params[i]),
            ) &&
            (!!(result.flags & F.Any) ||
              JSON.stringify(this.tryMap(result, at)) === JSON.stringify(f.result))
          );
        });
        if (compatible) return first;
      }
      return { record: this.record(t, at) };
    }
    return this.fail(at, 'E_TYPE_UNSUPPORTED', `Unsupported type ${this.checker.typeToString(t)}`);
  }

  /**
   * Whether function type `t` has properties, all declared in the program
   * (not in a package's declaration files: a framework's component types).
   */
  private programProperties(t: ts.Type): boolean {
    const props = this.checker.getPropertiesOfType(t);
    return (
      props.length > 0 &&
      props.every(p => (p.declarations ?? []).every(d => !d.getSourceFile().isDeclarationFile)) &&
      props.every(p => p.declarations?.length)
    );
  }

  /** Whether record `r` is a function with properties (its field 0, `()`, the function). */
  isCallable(r: number): boolean {
    return this.records[r]?.fields[0]?.name === '()';
  }

  /**
   * The type of the functions given to the property or field `node` names,
   * where TypeScript types it as any function (bits-ui's `static _cleanup?:
   * AnyFn`), with its nullable parts (frontend/unions.ts `anyFnSlot`).
   */
  givenFunction(node: ts.Node): ts.Type | undefined {
    const t = this.checker.getTypeAtLocation(node);
    if (!this.anyFnSlot || !this.anyFn(t)) return undefined;
    const name = ts.isPropertyAccessExpression(node) ? node.name : node;
    const sym = this.checker.getSymbolAtLocation(name);
    const decl = sym && (sym.valueDeclaration ?? sym.declarations?.[0]);
    const given = decl && this.anyFnSlot(decl);
    if (!given) return undefined;
    const nullable = (t.isUnion() ? t.types : [t]).reduce(
      (f, p) => f | (p.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)),
      0,
    );
    return nullable ? this.checker.getNullableType(given, nullable) : given;
  }

  /**
   * The host object `t` is, where it is the window or the document type of
   * the DOM declarations (also intersected: `Window & typeof globalThis`).
   */
  hostOf(t: ts.Type): 'window' | 'document' | undefined {
    const parts = t.isIntersection() ? t.types : [t];
    for (const p of parts) {
      const name = p.getSymbol()?.getName();
      if (name === 'HostWindow') return 'window';
      if (name === 'HostDocument') return 'document';
    }
    return undefined;
  }

  /**
   * Whether `t` (possibly optional) is a function type with `any` for its
   * result or as a rest parameter's items: `(...args: any[]) => any`
   * (svelte-toolbelt's `AnyFn`), svelte/elements' `MouseEventHandler<T>`
   * (`(event: …) => any`).
   */
  private anyFn(t: ts.Type): boolean {
    const parts = (t.isUnion() ? t.types : [t]).filter(
      p => !(p.flags & (ts.TypeFlags.Undefined | ts.TypeFlags.Null)),
    );
    if (parts.length !== 1) return false;
    const calls = parts[0].getCallSignatures();
    if (calls.length !== 1 || this.checker.getPropertiesOfType(parts[0]).length) return false;
    const [sig] = calls;
    const anyRest = sig.parameters.some(p => {
      const decl = p.valueDeclaration;
      const pt = this.checker.getTypeOfSymbol(p);
      return (
        !!decl &&
        ts.isParameter(decl) &&
        !!decl.dotDotDotToken &&
        this.checker.isArrayType(pt) &&
        !!(this.checker.getTypeArguments(pt as ts.TypeReference)[0]?.flags & ts.TypeFlags.Any)
      );
    });
    return anyRest || !!(sig.getReturnType().flags & ts.TypeFlags.Any);
  }

  /**
   * The parameters a rest parameter of type `t` stands for, one per item: a
   * tuple of required items, or a union of such tuples of the same item
   * types (bits-ui's `...args: Parameters<T> | []` with T = `() => void`).
   */
  restParams(t: ts.Type, at: ts.Node): Type[] | undefined {
    const parts = t.isUnion() ? t.types : [t];
    const items = parts.map(p => this.tupleItems(p, at));
    if (items.some(i => i === undefined)) return undefined;
    const first = JSON.stringify(items[0]);
    return items.every(i => JSON.stringify(i) === first) ? items[0] : undefined;
  }

  /**
   * The item types of a tuple of required items, or of `Parameters<F>` of a
   * type parameter bound to a function type (TypeScript leaves it deferred
   * inside a generic class).
   */
  private tupleItems(t: ts.Type, at: ts.Node): Type[] | undefined {
    if (this.checker.isTupleType(t))
      return ((t as ts.TypeReference).target as ts.TupleType).elementFlags.every(
        f => f & ts.ElementFlags.Required,
      )
        ? this.checker.getTypeArguments(t as ts.TypeReference).map(x => this.map(x, at))
        : undefined;
    const [f] = t.aliasTypeArguments ?? [];
    if (
      t.flags & ts.TypeFlags.Conditional &&
      t.aliasSymbol?.name === 'Parameters' &&
      /[\\/]lib\.[\w.]*\.d\.ts$/.test(
        t.aliasSymbol.declarations?.[0]?.getSourceFile().fileName ?? '',
      ) &&
      f &&
      f.flags & ts.TypeFlags.TypeParameter &&
      this.typeParameter?.(f)
    ) {
      const fn = this.map(f, at);
      return typeof fn === 'object' && 'fn' in fn ? fn.fn.params : undefined;
    }
    return undefined;
  }

  /** Tuple records (`Tuple`, fields `0`…), by their items' types. */
  readonly tuples = new Map<string, number>();

  /** The tuple record of items of these types. */
  tupleRecord(items: Type[]): number {
    const key = JSON.stringify(items);
    const known = this.tuples.get(key);
    if (known !== undefined) return known;
    const r = this.records.length;
    this.records.push({
      name: 'Tuple',
      tuple: true,
      fields: items.map((type, i) => ({ name: String(i), type })),
    });
    this.tuples.set(key, r);
    return r;
  }

  /** Whether values of type `t` may hold a tuple record. */
  containsTuple(t: Type, seen = new Set<number>()): boolean {
    if (typeof t !== 'object') return false;
    if ('record' in t) {
      if (this.isTuple(t.record)) return true;
      if (seen.has(t.record)) return false;
      seen.add(t.record);
      return (this.records[t.record]?.fields ?? []).some(f => this.containsTuple(f.type, seen));
    }
    if ('maybe' in t) return this.containsTuple(t.maybe, seen);
    if ('array' in t) return this.containsTuple(t.array, seen);
    if ('map' in t) return t.map.some(x => this.containsTuple(x, seen));
    if ('set' in t) return this.containsTuple(t.set, seen);
    return false;
  }

  /** Whether record `r` is a tuple record. */
  isTuple(r: number): boolean {
    return [...this.tuples.values()].includes(r);
  }

  /** Unions being mapped (recursion guard). */
  private readonly unions = new Set<ts.Type>();

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
    else if (this.classRecords(rest, at)) base = this.classRecords(rest, at)!;
    // (With dynamic values, M6 spike: a union of object types is dynamic,
    // as code building its values builds dynamic objects; a merged record
    // would need copies.)
    else if (rest.every(p => this.plainObject(p)) && this.dynHere()) return 'dyn';
    // (Nor is it a merged record where an inference looks for a static type.)
    else if (rest.every(p => this.plainObject(p)) && this.dynamic)
      return this.fail(at, 'E_TYPE_UNION', 'A union of object types is dynamic');
    else if (rest.every(p => this.plainObject(p)) && this.mergeable(rest, at))
      base = { record: this.unionRecord(rest, at) };
    else {
      // (A member outside the value model does not decide yet: the union
      // may be narrowed to another one.)
      const mapped = rest.map(p => (this.narrow ? this.tryMap(p, at) : this.map(p, at)));
      const first = JSON.stringify(mapped[0]);
      // Functions where one member's type takes every other's values
      // (bits-ui's `(() => null) | Getter<number | null>`): that type.
      const widest = rest.every(p => p.getCallSignatures().length)
        ? rest.findIndex(
            (w, i) =>
              mapped[i] !== undefined &&
              rest.every(p => p === w || this.checker.isTypeAssignableTo(p, w)),
          )
        : -1;
      if (mapped[0] !== undefined && mapped.every(m => JSON.stringify(m) === first))
        base = mapped[0]!;
      else if (widest >= 0) base = mapped[widest]!;
      // With dynamic values (M6 spike): dynamic, rather than one member a
      // census that cannot see every value narrows it to.
      else if (this.dynHere()) return 'dyn';
      // Narrowed by the values that reach it (frontend/unions.ts).
      else if (this.narrow) base = this.map(this.narrow(rest, at, this.fail), at);
      else
        return this.fail(
          at,
          'E_TYPE_UNION',
          `Union ${rest.map(p => this.checker.typeToString(p)).join(' | ')} is outside the value model (M2 supports nullable types and literal unions)`,
        );
    }
    // (A member already nullable, a type parameter bound to `maybe<X>`: one
    // layer; a dynamic value holds null and undefined itself.)
    return nullish.length && !maybeInner(base) && base !== 'dyn' ? { maybe: base } : base;
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
    // A CSS animation or transition (frontend/dom.d.ts), read through built-ins.
    if (t.getProperty('__runicAnimation')) return 'animation';
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
    // A ResizeObserver (frontend/dom.d.ts): a record holding its callback,
    // registered before the callback type (which names the observer).
    const callback = t.getProperty('__runicResizeObserver');
    if (callback) {
      if (this.resizeObserver === undefined) {
        this.resizeObserver = this.records.length;
        this.records.push({ name: 'ResizeObserver', class: true, fields: [] });
        const type = this.map(this.checker.getTypeOfSymbolAtLocation(callback, at), at);
        this.records[this.resizeObserver].fields = [{ name: 'callback', type }];
      }
      return { record: this.resizeObserver };
    }
    // An IntersectionObserver (frontend/dom.d.ts): likewise.
    const ioCallback = t.getProperty('__runicIntersectionObserver');
    if (ioCallback) {
      if (this.intersectionObserver === undefined) {
        this.intersectionObserver = this.records.length;
        this.records.push({ name: 'IntersectionObserver', class: true, fields: [] });
        const type = this.map(this.checker.getTypeOfSymbolAtLocation(ioCallback, at), at);
        this.records[this.intersectionObserver].fields = [{ name: 'callback', type }];
      }
      return { record: this.intersectionObserver };
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
    // (With dynamic values, M6 spike: an object literal's type with another
    // index signature, `{ [a]: 1 }` of an untyped key, is dynamic; so is an
    // empty one in JavaScript, `const counts = {}`, which code may add any
    // property to.)
    const literal = (t as ts.ObjectType).objectFlags;
    if (
      this.dynamic &&
      ((literal & (ts.ObjectFlags.ObjectLiteral | ts.ObjectFlags.JSLiteral) &&
        this.checker.getIndexInfosOfType(t).length) ||
        (literal & ts.ObjectFlags.JSLiteral &&
          !this.checker.getPropertiesOfType(t).length &&
          !t.getCallSignatures().length))
    )
      return this.dynHere()
        ? 'dyn'
        : this.fail(at, 'E_TYPE_UNSUPPORTED', 'An object of runtime keys is dynamic');
    const name = t.symbol?.name ?? t.aliasSymbol?.name;
    const args = (t as ts.TypeReference).target
      ? this.checker.getTypeArguments(t as ts.TypeReference)
      : [];
    if (this.checker.isArrayType(t) || this.checker.isTupleType(t)) {
      if (this.checker.isTupleType(t)) {
        const items = args.map(a => this.map(a, at));
        const first = JSON.stringify(items[0]);
        if (!items.every(i => JSON.stringify(i) === first)) {
          // A pair or triple of other types (a Map's entries, M6 overlays):
          // a tuple record, read by index and destructuring only.
          const target = (t as ts.TypeReference).target as ts.TupleType;
          if (target.elementFlags?.some(f => !(f & ts.ElementFlags.Required)))
            this.fail(
              at,
              'E_TYPE_UNSUPPORTED',
              'Tuples with optional or rest elements are outside the value model',
            );
          return { record: this.tupleRecord(items) };
        }
        return { array: items[0] ?? 'number' };
      }
      return { array: this.map(args[0], at) };
    }
    // (A WeakMap or WeakSet is a Map or Set: neither is iterable, and what
    // they keep alive is not observable.)
    if ((name === 'Map' || name === 'ReadonlyMap' || name === 'WeakMap') && args.length === 2)
      return { map: [this.map(args[0], at), this.map(args[1], at)] };
    if ((name === 'Set' || name === 'ReadonlySet' || name === 'WeakSet') && args.length === 1)
      return { set: this.map(args[0], at) };
    const calls = t.getCallSignatures();
    if (calls.length) {
      if (calls.length > 1)
        this.fail(at, 'E_TYPE_UNSUPPORTED', 'Overloaded function values are unsupported');
      // A function with properties the program assigns (bits-ui's
      // `debounce` result, `debounced.destroy = …`): a record of the
      // function (field `()`) and the properties.
      if (this.programProperties(t)) return { record: this.record(t, at) };
      const sig = calls[0];
      return {
        fn: {
          // (A host function, returning the window or the document: calls
          // of it are that object, `Lowerer.hostName`; it returns nothing.)
          params: sig.parameters.flatMap(p => {
            const pt = this.checker.getTypeOfSymbolAtLocation(p, at);
            // A rest parameter of a tuple type: one parameter per item, as
            // functions declaring it are lowered.
            const decl = p.valueDeclaration;
            if (decl && ts.isParameter(decl) && this.hostParameter?.(decl)) return [];
            const items =
              decl && ts.isParameter(decl) && decl.dotDotDotToken
                ? this.restParams(pt, at)
                : undefined;
            return items ?? [this.map(pt, at)];
          }),
          result: this.hostOf(sig.getReturnType()) ? 'void' : this.map(sig.getReturnType(), at),
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
    if (name === 'Error' && this.fromLib(t) && this.errorType) return { record: this.errorType() };
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
    // (A type of a specialisation's type parameters: mapped afresh, by shape.)
    if (this.uncached?.(t)) {
      const outer = this.byType.get(t);
      this.byType.delete(t);
      try {
        return this.recordOf(t, at);
      } finally {
        if (outer === undefined) this.byType.delete(t);
        else this.byType.set(t, outer);
      }
    }
    return this.recordOf(t, at);
  }

  private recordOf(t: ts.Type, at: ts.Node): number {
    const known = this.byType.get(t);
    if (known !== undefined) return known;
    // Required<T>, Partial<T> and Readonly<T> of a type implemented with
    // getters: its record (the getters give what they give, whatever the
    // optionality TypeScript states; shadcn-svelte's
    // `getContext<Required<ToggleGroupContext>>`).
    const alias = t.aliasSymbol?.name;
    const of = t.aliasTypeArguments?.[0];
    if (
      of &&
      ['Required', 'Partial', 'Readonly'].includes(alias ?? '') &&
      this.accessorTypes.has(of)
    ) {
      const index = this.record(of, at);
      this.byType.set(t, index);
      return index;
    }
    const index = this.records.length;
    // Register before mapping fields so recursive types terminate.
    this.byType.set(t, index);
    const placeholder: RecordType = {
      name: t.symbol?.name && t.symbol.name !== '__object' ? t.symbol.name : 'Object',
      fields: [],
    };
    this.records.push(placeholder);
    // A function with properties: the function first.
    const [call] = t.getCallSignatures();
    if (call) {
      placeholder.name = 'Function';
      placeholder.fields.push({
        name: '()',
        type: {
          fn: {
            params: call.parameters.map(p =>
              this.map(this.checker.getTypeOfSymbolAtLocation(p, at), at),
            ),
            result: this.map(call.getReturnType(), at),
          },
        },
      });
    }
    // (Also the widened type of such a literal: a function's inferred
    // result, declared by the literal with getters.)
    const literalDecl = t.symbol?.declarations?.[0];
    const accessors =
      this.accessorTypes.has(t) ||
      (!!literalDecl &&
        ts.isObjectLiteralExpression(literalDecl) &&
        literalDecl.properties.some(ts.isGetAccessorDeclaration));
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
      // A property typed `unknown` that only null and undefined reach (no
      // trigger passes bits-ui's tooltip payload) holds nothing else: null
      // and undefined, kept apart (`maybe` of `void`).
      // (A property typed only null holds nothing else either: bits-ui's
      // tooltip snippet's `[T] extends [never] ? null : T | null` payload.)
      const nothing =
        pt.flags & ts.TypeFlags.Null ||
        (pt.flags & ts.TypeFlags.Unknown && decl && this.nothingSlot?.(decl as ts.Declaration));
      // A property holding boxes of `unknown` that only null and undefined
      // reach (`current: unknown`): boxes of that.
      const current = pt.getProperty('current');
      const boxNothing =
        !nothing &&
        !!current &&
        !!(this.checker.getTypeOfSymbol(current).flags & ts.TypeFlags.Unknown) &&
        !!decl &&
        !!this.nothingInBoxes?.(decl as ts.Declaration);
      // A property typed as a function with `any` in it (bits-ui's menu
      // `onClose: AnyFn`): the type of the functions given to it.
      // (Also a box of such a function: bits-ui's `onSelect: ReadableBox<AnyFn>`.)
      const boxOfAnyFn = (() => {
        const current = pt.getProperty('current');
        return !!current && this.anyFn(this.checker.getTypeOfSymbol(current));
      })();
      const given =
        !nothing && decl && (this.anyFn(pt) || boxOfAnyFn)
          ? this.anyFnSlot?.(decl as ts.Declaration, boxOfAnyFn)
          : undefined;
      if (given) pt = given;
      const outer = this.boxNothing;
      this.boxNothing = boxNothing;
      let mapped: Type;
      try {
        mapped = nothing ? { maybe: 'void' } : this.map(pt, where);
      } finally {
        this.boxNothing = outer;
      }
      placeholder.fields.push({
        name: p.name,
        type: accessors ? { fn: { params: [], result: mapped } } : mapped,
      });
    }
    if (accessors) {
      this.accessors.add(index);
      this.packageRecords.add(index);
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
    const shape = (accessors ? 'accessors:' : '') + JSON.stringify(placeholder.fields);
    const same = this.byShape.get(shape);
    const last = index === this.records.length - 1;
    const referenced = () =>
      this.records.some(
        r => r !== placeholder && JSON.stringify(r.fields).includes(`{"record":${index}}`),
      );
    if (
      same !== undefined &&
      same !== index &&
      !this.referencesSelf(placeholder, index) &&
      (last || !referenced())
    ) {
      // The last record is dropped; one registered before records its
      // fields registered (an equal record among them: a spread's source)
      // stays unused.
      if (last) this.records.pop();
      this.byType.set(t, same);
      return same;
    }
    this.byShape.set(shape, index);
    return index;
  }

  /**
   * A union of types that map to different class records not compiled from
   * source (svelte-toolbelt's boxes: `WritableBox<string> |
   * WritableBox<string[]>`): a class reference to them. Undefined otherwise.
   */
  private classRecords(parts: ts.Type[], at: ts.Node): Type | undefined {
    if (parts.length < 2 || parts.some(p => this.sourceClass(p))) return undefined;
    const records: number[] = [];
    for (const p of parts) {
      if (!(p.flags & (ts.TypeFlags.Object | ts.TypeFlags.Intersection))) return undefined;
      const m = this.tryMap(p, at);
      if (!(typeof m === 'object' && 'record' in m) || !this.records[m.record].class)
        return undefined;
      if (this.records[m.record].extends !== undefined) return undefined;
      records.push(m.record);
    }
    const unique = [...new Set(records)].sort((a, b) => a - b);
    return unique.length === 1 ? { record: unique[0] } : { classes: unique };
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
    return !(
      s && ['Map', 'Set', 'WeakMap', 'WeakSet', 'Promise', 'Date', 'RegExp', 'Array'].includes(s)
    );
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

  /**
   * One record for several plain object types (a field's options types
   * along a class hierarchy, bits-ui's `ToggleGroupBaseStateOpts`,
   * `…SingleStateOpts` and `…MultipleStateOpts`): every property of any of
   * them, nullable where one lacks it; a property whose types are different
   * class records (svelte-toolbelt's boxes of different values) a class
   * reference to them. Each type maps to it from then on. Undefined when the
   * types cannot share a record (other differing types, or one already
   * mapped).
   */
  mergeRecords(parts: ts.Type[], at: ts.Node): number | undefined {
    const unique = [...new Set(parts)];
    // Merged already (the field of another subclass of the hierarchy).
    const done = new Set(unique.map(p => this.byType.get(p)));
    if (done.size === 1 && !done.has(undefined)) return [...done][0];
    if (unique.some(p => this.byType.has(p) || !this.plainObject(p))) return undefined;
    const names: string[] = [];
    for (const p of unique)
      for (const prop of this.checker.getPropertiesOfType(p))
        if (!names.includes(prop.name)) names.push(prop.name);
    const fields: { name: string; type: Type }[] = [];
    for (const name of names) {
      const types: Type[] = [];
      let nullable = false;
      for (const p of unique) {
        const prop = this.checker.getPropertyOfType(p, name);
        if (!prop) {
          nullable = true;
          continue;
        }
        let pt = this.checker.getTypeOfSymbolAtLocation(prop, prop.valueDeclaration ?? at);
        if (prop.flags & ts.SymbolFlags.Optional)
          pt = this.checker.getNullableType(pt, ts.TypeFlags.Undefined);
        const m = this.tryMap(pt, at);
        if (m === undefined) return undefined;
        if (maybeInner(m)) nullable = true;
        types.push(maybeInner(m) ?? m);
      }
      const keys = [...new Set(types.map(x => JSON.stringify(x)))];
      let type: Type;
      if (keys.length === 1) type = types[0];
      else if (
        types.every(x => typeof x === 'object' && 'record' in x && this.records[x.record].class)
      )
        type = {
          classes: [...new Set(types.map(x => (x as { record: number }).record))].sort(
            (a, b) => a - b,
          ),
        };
      else return undefined;
      fields.push({ name, type: nullable ? { maybe: type } : type });
    }
    const index = this.records.length;
    this.records.push({ name: 'Object', fields });
    this.packageRecords.add(index);
    this.merged.add(index);
    for (const p of unique) this.byType.set(p, index);
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

  /** A plain record of `fields` (shared by shape with another plain record). */
  shapeRecord(fields: RecordField[]): number {
    const shape = JSON.stringify(fields);
    const same = this.byShape.get(shape);
    if (same !== undefined && !this.records[same].class && !this.accessors.has(same)) return same;
    this.records.push({ name: 'Object', fields });
    this.byShape.set(shape, this.records.length - 1);
    return this.records.length - 1;
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

/** Whether `t` is declared by the csstype package (CSS property types). */
const cssType = (t: ts.Type): boolean =>
  /[\\/]node_modules[\\/]csstype[\\/]/.test(
    (t.aliasSymbol ?? t.symbol)?.declarations?.[0]?.getSourceFile().fileName ?? '',
  );

export const sameType = (a: Type, b: Type) => JSON.stringify(a) === JSON.stringify(b);

/**
 * Whether TypeScript's type `t` has `any` (or `unknown`) in it: itself, a
 * union member, a property, a type argument, a parameter or a result.
 */
export function containsAny(
  t: ts.Type,
  checker: ts.TypeChecker,
  depth = 0,
  /** Also a value that is only ever null (`simpleBox(null)`). */
  nulls = false,
): boolean {
  if (t.flags & (ts.TypeFlags.Any | ts.TypeFlags.Unknown)) return true;
  if (nulls && t.flags & ts.TypeFlags.Null) return true;
  if (depth > 3) return false;
  if (t.isUnion() || t.isIntersection())
    return t.types.some(m => containsAny(m, checker, depth + 1, nulls));
  if (!(t.flags & ts.TypeFlags.Object)) return false;
  if (t.getProperty('__runicElement') || t.getProperty('__runicEvent')) return false;
  // Types of TypeScript's library (Set<T>, Promise<T>): their type arguments.
  const file = t.symbol?.declarations?.[0]?.getSourceFile().fileName ?? '';
  if (/[\\/]lib\.[\w.]*\.d\.ts$/.test(file))
    return (
      !!(t as ts.TypeReference).target &&
      checker
        .getTypeArguments(t as ts.TypeReference)
        .some(a => containsAny(a, checker, depth + 1, nulls))
    );
  const props = checker.getPropertiesOfType(t);
  if (
    props.length <= 40 &&
    props.some(p => containsAny(checker.getTypeOfSymbol(p), checker, depth + 1, nulls))
  )
    return true;
  return t
    .getCallSignatures()
    .some(
      sig =>
        containsAny(sig.getReturnType(), checker, depth + 1, nulls) ||
        sig.parameters.some(p =>
          containsAny(checker.getTypeOfSymbol(p), checker, depth + 1, nulls),
        ),
    );
}
