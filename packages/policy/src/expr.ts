/**
 * A tiny, safe expression language for policy `when` clauses (§7.1). CEL-like subset:
 * literals, member access, ==, !=, <, <=, >, >=, &&, ||, !, `in`, list literals,
 * method calls (startsWith, endsWith, contains) and whitelisted helper functions.
 * It is parsed into an AST and interpreted. No eval, no Function, no prototype access.
 */
type Tok =
  | { t: "num"; v: number }
  | { t: "str"; v: string }
  | { t: "id"; v: string }
  | { t: "op"; v: string }
  | { t: "eof" };

export type Node =
  | { k: "lit"; v: unknown }
  | { k: "id"; name: string }
  | { k: "member"; obj: Node; prop: string }
  | { k: "call"; callee: Node; args: Node[] }
  | { k: "list"; items: Node[] }
  | { k: "unary"; op: "!" | "-"; arg: Node }
  | { k: "bin"; op: string; l: Node; r: Node };

export class ExprError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ExprError";
  }
}

const MAX_LEN = 2000;
const MAX_DEPTH = 32;

function lex(src: string): Tok[] {
  if (src.length > MAX_LEN) throw new ExprError("expression too long");
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i]!;
    if (/\s/.test(c)) { i++; continue; }
    if (/[0-9]/.test(c)) {
      const m = /^[0-9]+(\.[0-9]+)?/.exec(src.slice(i))!;
      out.push({ t: "num", v: Number(m[0]) });
      i += m[0].length;
      continue;
    }
    if (c === '"' || c === "'") {
      let j = i + 1;
      let s = "";
      while (j < src.length && src[j] !== c) {
        if (src[j] === "\\" && j + 1 < src.length) { s += src[j + 1]; j += 2; continue; }
        s += src[j];
        j++;
      }
      if (j >= src.length) throw new ExprError("unterminated string");
      out.push({ t: "str", v: s });
      i = j + 1;
      continue;
    }
    if (/[A-Za-z_]/.test(c)) {
      const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(src.slice(i))!;
      out.push({ t: "id", v: m[0] });
      i += m[0].length;
      continue;
    }
    const two = src.slice(i, i + 2);
    if (["==", "!=", "<=", ">=", "&&", "||"].includes(two)) { out.push({ t: "op", v: two }); i += 2; continue; }
    if ("<>!().,[]-".includes(c)) { out.push({ t: "op", v: c }); i++; continue; }
    throw new ExprError(`unexpected character '${c}'`);
  }
  out.push({ t: "eof" });
  return out;
}

const PREC: Record<string, number> = { "||": 1, "&&": 2, "==": 3, "!=": 3, in: 3, "<": 4, "<=": 4, ">": 4, ">=": 4 };

export function parse(src: string): Node {
  const toks = lex(src);
  let p = 0;
  const peek = () => toks[p]!;
  const isOp = (v: string) => { const t = peek(); return (t.t === "op" || t.t === "id") && t.v === v; };
  const expect = (v: string) => { if (!isOp(v)) throw new ExprError(`expected '${v}'`); p++; };

  const primary = (depth: number): Node => {
    if (depth > MAX_DEPTH) throw new ExprError("expression too deep");
    const t = peek();
    let node: Node;
    if (t.t === "num" || t.t === "str") { p++; node = { k: "lit", v: t.v }; }
    else if (t.t === "id") {
      p++;
      if (t.v === "true") node = { k: "lit", v: true };
      else if (t.v === "false") node = { k: "lit", v: false };
      else if (t.v === "null") node = { k: "lit", v: null };
      else node = { k: "id", name: t.v };
    } else if (isOp("(")) { p++; node = expr(0, depth + 1); expect(")"); }
    else if (isOp("[")) {
      p++;
      const items: Node[] = [];
      if (!isOp("]")) { do { items.push(expr(0, depth + 1)); } while (isOp(",") && ++p); }
      expect("]");
      node = { k: "list", items };
    } else if (isOp("!") || isOp("-")) {
      const op = (peek() as { v: string }).v as "!" | "-";
      p++;
      node = { k: "unary", op, arg: primary(depth + 1) };
    } else throw new ExprError("unexpected token");

    for (;;) {
      if (isOp(".")) {
        p++;
        const id = peek();
        if (id.t !== "id") throw new ExprError("expected property name");
        p++;
        node = { k: "member", obj: node, prop: id.v };
      } else if (isOp("(")) {
        p++;
        const args: Node[] = [];
        if (!isOp(")")) { do { args.push(expr(0, depth + 1)); } while (isOp(",") && ++p); }
        expect(")");
        node = { k: "call", callee: node, args };
      } else break;
    }
    return node;
  };

  const expr = (minPrec: number, depth: number): Node => {
    let left = primary(depth);
    for (;;) {
      const t = peek();
      const op = t.t === "op" || (t.t === "id" && t.v === "in") ? (t as { v: string }).v : undefined;
      const prec = op ? PREC[op] : undefined;
      if (!op || prec === undefined || prec <= minPrec - 1 || prec < minPrec) break;
      p++;
      const right = expr(prec + 1, depth + 1);
      left = { k: "bin", op, l: left, r: right };
    }
    return left;
  };

  const ast = expr(0, 0);
  if (peek().t !== "eof") throw new ExprError("unexpected trailing input");
  return ast;
}

/** Values a `when` clause may see. Helpers are plain functions; nothing else is callable. */
export type Scope = Record<string, unknown>;

const FORBIDDEN_PROPS = new Set(["__proto__", "prototype", "constructor"]);

function getProp(obj: unknown, prop: string): unknown {
  if (FORBIDDEN_PROPS.has(prop)) throw new ExprError("forbidden property");
  if (obj === null || obj === undefined) return undefined;
  if (typeof obj === "string" && prop === "length") return obj.length;
  if (Array.isArray(obj) && prop === "length") return obj.length;
  if (typeof obj !== "object" && typeof obj !== "function") return undefined;
  return Object.prototype.hasOwnProperty.call(obj, prop) ? (obj as Record<string, unknown>)[prop] : undefined;
}

const STRING_METHODS: Record<string, (s: string, a: unknown) => boolean> = {
  startsWith: (s, a) => typeof a === "string" && s.startsWith(a),
  endsWith: (s, a) => typeof a === "string" && s.endsWith(a),
  contains: (s, a) => typeof a === "string" && s.includes(a),
};

function eq(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a === "number" && typeof b === "string") return a === Number(b);
  if (typeof b === "number" && typeof a === "string") return b === Number(a);
  return false;
}

function cmp(a: unknown, b: unknown): number | null {
  if (typeof a === "number" && typeof b === "number") return a - b;
  if (typeof a === "string" && typeof b === "string") return a < b ? -1 : a > b ? 1 : 0;
  return null;
}

export function evaluate(node: Node, scope: Scope): unknown {
  switch (node.k) {
    case "lit": return node.v;
    case "id": return Object.prototype.hasOwnProperty.call(scope, node.name) ? scope[node.name] : undefined;
    case "member": return getProp(evaluate(node.obj, scope), node.prop);
    case "list": return node.items.map((n) => evaluate(n, scope));
    case "unary": {
      const v = evaluate(node.arg, scope);
      return node.op === "!" ? !truthy(v) : -Number(v);
    }
    case "call": {
      // Method on a string: x.startsWith("a")
      if (node.callee.k === "member") {
        const target = evaluate(node.callee.obj, scope);
        const name = node.callee.prop;
        if (typeof target === "string" && STRING_METHODS[name]) return STRING_METHODS[name](target, evaluate(node.args[0] ?? { k: "lit", v: undefined }, scope));
        if (Array.isArray(target) && name === "contains") return target.some((x) => eq(x, evaluate(node.args[0]!, scope)));
        // Helper objects (diff.changed, run.count) expose functions explicitly.
        const fn = getProp(target, name);
        if (typeof fn === "function") return (fn as (...a: unknown[]) => unknown)(...node.args.map((a) => (isLazy(fn) ? a : evaluate(a, scope))), scope);
        throw new ExprError(`unknown method ${name}`);
      }
      if (node.callee.k === "id") {
        const fn = scope[node.callee.name];
        if (typeof fn === "function") return (fn as (...a: unknown[]) => unknown)(...node.args.map((a) => evaluate(a, scope)));
      }
      throw new ExprError("not callable");
    }
    case "bin": {
      if (node.op === "&&") return truthy(evaluate(node.l, scope)) && truthy(evaluate(node.r, scope));
      if (node.op === "||") return truthy(evaluate(node.l, scope)) || truthy(evaluate(node.r, scope));
      const l = evaluate(node.l, scope);
      const r = evaluate(node.r, scope);
      switch (node.op) {
        case "==": return eq(l, r);
        case "!=": return !eq(l, r);
        case "in": return Array.isArray(r) ? r.some((x) => eq(l, x)) : typeof r === "string" && typeof l === "string" ? r.includes(l) : false;
        case "<": { const c = cmp(l, r); return c !== null && c < 0; }
        case "<=": { const c = cmp(l, r); return c !== null && c <= 0; }
        case ">": { const c = cmp(l, r); return c !== null && c > 0; }
        case ">=": { const c = cmp(l, r); return c !== null && c >= 0; }
      }
      throw new ExprError(`unknown operator ${node.op}`);
    }
  }
}

export function truthy(v: unknown): boolean {
  return v !== false && v !== null && v !== undefined && v !== 0 && v !== "";
}

const LAZY = Symbol("lazy");
/** Marks a helper whose arguments are passed as AST nodes (e.g. run.count(kind in [...])). */
export function lazy<F extends (...a: never[]) => unknown>(fn: F): F {
  (fn as unknown as Record<symbol, boolean>)[LAZY] = true;
  return fn;
}
function isLazy(fn: unknown): boolean {
  return typeof fn === "function" && (fn as unknown as Record<symbol, boolean>)[LAZY] === true;
}
