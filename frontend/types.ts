// TypeScript checker types → IR types (docs/design/M2-VALUES.md, D16).
import ts from 'typescript';
import type { RecordType, Type } from './ir.ts';

export type Fail = (node: ts.Node, code: string, message: string) => never;

export class TypeMapper {
  readonly records: RecordType[] = [];
  private byType = new Map<ts.Type, number>();
  private byShape = new Map<string, number>();

  private checker: ts.TypeChecker;
  private fail: Fail;

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

  private overridden(node: ts.Node): Type | undefined {
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

  map(t: ts.Type, at: ts.Node): Type {
    const F = ts.TypeFlags;
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
    if (t.flags & F.Object) return this.object(t as ts.ObjectType, at);
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
    if (name && ['Date', 'RegExp', 'Promise', 'Error', 'HTMLElement', 'Event'].includes(name))
      this.fail(at, 'E_TYPE_UNSUPPORTED', `${name} values are planned for a later milestone`);
    return { record: this.record(t, at) };
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
      placeholder.fields.push({ name: p.name, type: this.map(pt, decl ?? at) });
    }
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

  private referencesSelf(r: RecordType, index: number): boolean {
    return JSON.stringify(r.fields).includes(`{"record":${index}}`);
  }

  fieldIndex(record: number, name: string, at: ts.Node): number {
    const i = this.records[record].fields.findIndex(f => f.name === name);
    if (i < 0) this.fail(at, 'E_FIELD', `Record ${this.records[record].name} has no field ${name}`);
    return i;
  }
}

export const sameType = (a: Type, b: Type) => JSON.stringify(a) === JSON.stringify(b);
