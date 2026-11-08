// What a person did, and how to take it back.
export interface Undoable {
  label: string; // said back to the person when undone
  undo: () => void;
}

export class UndoStack {
  private items: Undoable[] = [];

  constructor(private depth = 40) {}

  push(u: Undoable): void {
    this.items.push(u);
    if (this.items.length > this.depth) this.items.shift();
  }

  undo(): string | null {
    const u = this.items.pop();
    if (!u) return null;
    u.undo();
    return u.label;
  }
}
