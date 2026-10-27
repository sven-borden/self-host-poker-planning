// Rules for "no literal copy in components" (ADR-012): every word a person reads or
// hears comes from a catalog through `t`, so it exists in en, fr and de. Pure functions on
// the parsed source (Vite's oxc parser, which reads TSX), so the rules are tested
// directly; check-copy.ts walks the files.
import { parseAst } from "vite";

export interface CopyFinding {
  file: string;
  line: number;
  column: number;
  match: string;
  rule: string;
}

/** Attributes a person reads or a screen reader speaks. */
const SPOKEN_ATTRIBUTES = new Set([
  "aria-label",
  "aria-description",
  "aria-placeholder",
  "aria-roledescription",
  "aria-valuetext",
  "title",
  "placeholder",
  "alt",
]);

const LETTER = /\p{L}/u;

interface Node {
  type: string;
  start: number;
  [key: string]: unknown;
}

function isNode(value: unknown): value is Node {
  return (
    typeof value === "object" && value !== null && typeof Reflect.get(value, "type") === "string"
  );
}

/** The text of a string literal or a template without expressions, else null. */
function literalText(node: unknown): string | null {
  if (!isNode(node)) {
    return null;
  }
  if (node.type === "Literal" && typeof node.value === "string") {
    return node.value;
  }
  if (
    node.type === "TemplateLiteral" &&
    Array.isArray(node.expressions) &&
    node.expressions.length === 0
  ) {
    const [quasi] = node.quasis as { value: { cooked: string } }[];
    return quasi?.value.cooked ?? null;
  }
  if (node.type === "JSXExpressionContainer") {
    return literalText(node.expression);
  }
  return null;
}

function attributeName(node: Node): string | null {
  const name = node.name;
  return isNode(name) && name.type === "JSXIdentifier" ? String(name.name) : null;
}

/** Every literal piece of copy in one .tsx source, with 1-based line and column. */
export function findLiteralCopy(source: string, file: string): CopyFinding[] {
  const program = parseAst(source, { lang: "tsx" }) as unknown as Node;
  const hits: { index: number; match: string; rule: string }[] = [];
  const visit = (node: Node) => {
    if (node.type === "JSXText") {
      const text = String(node.value).trim();
      if (LETTER.test(text)) {
        hits.push({
          index: node.start + String(node.value).indexOf(text),
          match: text,
          rule: "literal JSX text",
        });
      }
    } else if (node.type === "JSXAttribute") {
      const name = attributeName(node);
      const text = literalText(node.value);
      if (name && SPOKEN_ATTRIBUTES.has(name) && text !== null && LETTER.test(text)) {
        hits.push({ index: node.start, match: `${name}="${text}"`, rule: `literal ${name}` });
      }
    }
    for (const child of Object.values(node)) {
      for (const item of Array.isArray(child) ? child : [child]) {
        if (isNode(item)) {
          visit(item);
        }
      }
    }
  };
  visit(program);
  const lineStarts = [0];
  for (let index = source.indexOf("\n"); index !== -1; index = source.indexOf("\n", index + 1)) {
    lineStarts.push(index + 1);
  }
  return hits
    .map(({ index, match, rule }) => {
      let line = lineStarts.length - 1;
      while ((lineStarts[line] ?? 0) > index) {
        line -= 1;
      }
      return { file, line: line + 1, column: index - (lineStarts[line] ?? 0) + 1, match, rule };
    })
    .sort((a, b) => a.line - b.line || a.column - b.column);
}

/** Files in scope: components and routes, not their tests. */
export function isCheckedFile(path: string): boolean {
  const name = path.replaceAll("\\", "/").split("/").at(-1) ?? "";
  return name.endsWith(".tsx") && !name.endsWith(".test.tsx");
}

export function formatFinding(finding: CopyFinding): string {
  return `${finding.file}:${finding.line}:${finding.column}  ${finding.rule}: ${finding.match}`;
}
