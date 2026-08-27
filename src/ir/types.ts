/* ============================================================
   sparkEditor · src/ir/types.ts
   Intermediate representation shared by all editor surfaces.
   ============================================================ */

export type InlineMark = "bold" | "italic" | "code" | "link" | "strikethrough";

export interface Inline {
  text: string;
  marks?: InlineMark[];
  href?: string;
}

export type Block =
  | { kind: "paragraph";   id: string; inlines: Inline[] }
  | { kind: "heading";     id: string; level: 1 | 2 | 3 | 4 | 5 | 6; inlines: Inline[] }
  | { kind: "blockquote";  id: string; children: Block[] }
  | { kind: "list";        id: string; ordered: boolean; items: ListItem[] }
  | { kind: "code";        id: string; lang?: string; value: string }
  | { kind: "thematic";    id: string }
  | { kind: "html";        id: string; value: string };

export interface ListItem { id: string; blocks: Block[]; checked?: boolean }

export interface Document {
  version: 1;
  blocks: Block[];
}
