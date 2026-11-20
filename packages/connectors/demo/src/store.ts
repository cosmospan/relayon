/** In-memory fake app. One store per Executor process, partitioned by connection id. */
export interface DemoRecord {
  id: string;
  title: string;
  status: string;
  body: string;
  trashed: boolean;
  version: number;
}

export interface DemoMessage {
  id: string;
  to: string;
  text: string;
}

export class DemoStore {
  readonly #records = new Map<string, Map<string, DemoRecord>>();
  readonly #messages = new Map<string, DemoMessage[]>();
  #seq = 0;

  #bucket(conn: string): Map<string, DemoRecord> {
    let b = this.#records.get(conn);
    if (!b) this.#records.set(conn, (b = new Map()));
    return b;
  }

  nextId(prefix: string): string {
    this.#seq += 1;
    return `${prefix}_${this.#seq.toString().padStart(6, "0")}`;
  }

  get(conn: string, id: string): DemoRecord | undefined {
    const r = this.#bucket(conn).get(id);
    return r ? { ...r } : undefined;
  }

  list(conn: string, includeTrashed = false): DemoRecord[] {
    return [...this.#bucket(conn).values()].filter((r) => includeTrashed || !r.trashed).map((r) => ({ ...r }));
  }

  put(conn: string, r: DemoRecord): DemoRecord {
    this.#bucket(conn).set(r.id, { ...r });
    return { ...r };
  }

  send(conn: string, to: string, text: string): DemoMessage {
    const m = { id: this.nextId("msg"), to, text };
    const list = this.#messages.get(conn) ?? [];
    list.push(m);
    this.#messages.set(conn, list);
    return m;
  }

  messages(conn: string): DemoMessage[] {
    return [...(this.#messages.get(conn) ?? [])];
  }
}
