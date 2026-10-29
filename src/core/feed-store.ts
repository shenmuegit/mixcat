import { DatabaseSync } from 'node:sqlite';
import { lstatSync } from 'node:fs';
import { join } from 'node:path';
import { ensureProjectDirectory, insideProject, projectDirectory } from './paths.js';

export class FeedStore {
  readonly root: string;
  readonly db: DatabaseSync;
  private ownership: DatabaseSync;
  private closed = false;
  private depth = 0;
  private committed: (() => void)[] = [];
  constructor(workbenchRoot: string) {
    this.root = ensureProjectDirectory(workbenchRoot);
    const directory = projectDirectory(this.root, '.runtime', 'client', 'feed');
    const writerFile = insideProject(this.root, join(directory, 'writer.sqlite')), feedFile = insideProject(this.root, join(directory, 'feed.sqlite'));
    for (const file of [writerFile, feedFile]) for (const suffix of ['', '-wal', '-shm', '-journal']) {
      const path = insideProject(this.root, `${file}${suffix}`);
      // lstat also detects dangling links before SQLite can create their targets.
      const stat = lstatSync(path, { throwIfNoEntry: false });
      if (stat?.isSymbolicLink()) throw new Error(`数据库路径不能经过符号链接或目录联接：${path}`);
      if (stat && stat.nlink > 1) throw new Error(`数据库路径不能使用硬链接：${path}`);
    }
    this.ownership = new DatabaseSync(writerFile);
    try { this.ownership.exec('BEGIN EXCLUSIVE'); }
    catch (error) {
      this.ownership.close();
      if ([5, 6].includes((error as any).errcode)) throw new Error('个人信息流已由其他工作台打开。', { cause: error });
      throw error;
    }
    let database: DatabaseSync | undefined;
    try {
      database = new DatabaseSync(feedFile);
      this.db = database;
      this.db.exec('PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;');
      const version = Number(this.db.prepare('PRAGMA user_version').get()!.user_version);
      if (version > 2) throw new Error('个人信息流数据版本不受当前应用支持。');
      if (version === 0) this.transaction(() => this.db.exec(`
        CREATE TABLE feed_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, generation INTEGER NOT NULL);
        INSERT INTO feed_meta VALUES(1,0,0);
        CREATE TABLE feed_entries (id TEXT PRIMARY KEY, dedup_key TEXT UNIQUE, body TEXT NOT NULL);
        CREATE TABLE feed_discoveries (id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT NOT NULL REFERENCES feed_entries(id), collection_id TEXT, actor TEXT NOT NULL, collected_at TEXT NOT NULL);
        CREATE INDEX feed_discoveries_entry ON feed_discoveries(entry_id,id);
        CREATE INDEX feed_discoveries_collection ON feed_discoveries(collection_id,entry_id);
        CREATE TABLE feed_receipts (key TEXT PRIMARY KEY, input TEXT NOT NULL, response TEXT NOT NULL);
        CREATE TABLE feed_drafts (key TEXT PRIMARY KEY, body TEXT NOT NULL);
        PRAGMA user_version=1;
      `));
      if (version < 2) this.transaction(() => this.db.exec(`
        CREATE TABLE feed_collections (id TEXT PRIMARY KEY, body TEXT NOT NULL);
        CREATE TABLE feed_runs (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, collection_id TEXT NOT NULL REFERENCES feed_collections(id), body TEXT NOT NULL);
        CREATE INDEX feed_runs_collection ON feed_runs(collection_id,seq);
        CREATE TABLE feed_history (seq INTEGER PRIMARY KEY AUTOINCREMENT, id TEXT UNIQUE NOT NULL, collection_id TEXT NOT NULL REFERENCES feed_collections(id), thread_id TEXT, turn_id TEXT, item_id TEXT, body TEXT NOT NULL, UNIQUE(collection_id,thread_id,turn_id,item_id));
        CREATE INDEX feed_history_collection ON feed_history(collection_id,seq);
        CREATE TABLE feed_source_failures (seq INTEGER PRIMARY KEY AUTOINCREMENT, run_id TEXT NOT NULL REFERENCES feed_runs(id), body TEXT NOT NULL);
        PRAGMA user_version=2;
      `));
    } catch (error) { database?.close(); this.ownership.close(); throw error; }
  }
  get revision(): number { return Number(this.db.prepare('SELECT revision FROM feed_meta WHERE id=1').get()!.revision); }
  get generation(): number { return Number(this.db.prepare('SELECT generation FROM feed_meta WHERE id=1').get()!.generation); }
  bumpRevision(): number { this.db.exec('UPDATE feed_meta SET revision=revision+1 WHERE id=1'); return this.revision; }
  nextGeneration(): number { this.db.exec('UPDATE feed_meta SET generation=generation+1 WHERE id=1'); return this.generation; }
  get inTransaction() { return this.depth > 0; }
  afterCommit(effect: () => void) { if (this.depth) this.committed.push(effect); else effect(); }
  transaction<T>(operation: () => T): T {
    const level = this.depth++, mark = this.committed.length;
    let result: T;
    try {
      this.db.exec(level ? `SAVEPOINT feed_${level}` : 'BEGIN IMMEDIATE');
      try {
        result = operation();
        if (result && typeof (result as any).then === 'function') throw new Error('个人存储事务必须同步完成。');
        this.db.exec(level ? `RELEASE feed_${level}` : 'COMMIT');
      } catch (error) { this.committed.length = mark; this.db.exec(level ? `ROLLBACK TO feed_${level}; RELEASE feed_${level}` : 'ROLLBACK'); throw error; }
    } finally { this.depth--; }
    if (!level) { const effects = this.committed.splice(0); for (const effect of effects) effect(); }
    return result;
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); } finally { this.ownership.close(); }
  }
}
