import { DatabaseSync } from 'node:sqlite';
import { lstatSync, rmSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import { ensureProjectDirectory, insideProject, projectDirectory } from './paths.js';

export function feedCollectionDataPath(workbench: string, id: string, directory?: string) {
  return directory ? join(directory, '.mixcat', 'feed', id) : join(workbench, '.runtime', 'client', 'feed', 'collections', id);
}

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
      if (version > 3) throw new Error('个人信息流数据版本不受当前应用支持。');
      if (version === 0) this.transaction(() => this.db.exec(`
        CREATE TABLE feed_meta (id INTEGER PRIMARY KEY CHECK(id=1), revision INTEGER NOT NULL, generation INTEGER NOT NULL);
        INSERT INTO feed_meta VALUES(1,0,0);
        CREATE TABLE feed_entries (id TEXT PRIMARY KEY, dedup_key TEXT UNIQUE, body TEXT NOT NULL);
        CREATE TABLE feed_discoveries (id INTEGER PRIMARY KEY AUTOINCREMENT, entry_id TEXT NOT NULL REFERENCES feed_entries(id), collection_id TEXT, actor TEXT NOT NULL, collected_at TEXT NOT NULL);
        CREATE INDEX feed_discoveries_entry ON feed_discoveries(entry_id,id);
        CREATE INDEX feed_discoveries_collection ON feed_discoveries(collection_id,entry_id);
        CREATE TABLE feed_receipts (key TEXT PRIMARY KEY, input TEXT NOT NULL, response TEXT NOT NULL);
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
      if (version < 3) this.transaction(() => this.db.exec(`
        CREATE TABLE feed_collection_cleanup (collection_id TEXT PRIMARY KEY, directory TEXT, device TEXT NOT NULL, inode TEXT NOT NULL);
        PRAGMA user_version=3;
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
  private collectionDirectory(id: string, directory?: string) {
    if (!/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(id)) throw Error('采集目录标识无效。');
    const root = directory ?? this.root;
    const target = feedCollectionDataPath(this.root, id, directory);
    const stat = lstatSync(target, { bigint: true, throwIfNoEntry: false });
    if (!stat) return;
    const path = insideProject(root, target);
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw Error('采集数据路径不是应用创建的目录。');
    for (const row of this.db.prepare("SELECT json_extract(body,'$.directory') AS directory FROM feed_collections WHERE id<>? AND json_extract(body,'$.directory') IS NOT NULL").all(id)) {
      const part = relative(path, String(row.directory));
      if (!part || part !== '..' && !part.startsWith(`..${sep}`) && !isAbsolute(part)) throw Error('另一个采集任务正使用该目录，不能永久删除。');
    }
    return { path, device: String(stat.dev), inode: String(stat.ino) };
  }
  queueCollectionCleanup(id: string, directory?: string) {
    const owned = this.collectionDirectory(id, directory);
    if (owned) this.db.prepare('INSERT INTO feed_collection_cleanup VALUES(?,?,?,?)').run(id, directory ?? null, owned.device, owned.inode);
  }
  pendingCollectionCleanup(): string[] {
    return this.db.prepare('SELECT collection_id FROM feed_collection_cleanup').all().map(row => String(row.collection_id));
  }
  finishCollectionCleanup(id: string) {
    const pending = this.db.prepare('SELECT directory,device,inode FROM feed_collection_cleanup WHERE collection_id=?').get(id);
    if (!pending) return;
    const owned = this.collectionDirectory(id, pending.directory === null ? undefined : String(pending.directory));
    if (owned) {
      if (owned.device !== pending.device || owned.inode !== pending.inode) throw Error('采集数据目录已被替换，无法确认归属。');
      rmSync(owned.path, { recursive: true, force: true });
    }
    this.db.prepare('DELETE FROM feed_collection_cleanup WHERE collection_id=?').run(id);
  }
  close() {
    if (this.closed) return;
    this.closed = true;
    try { this.db.close(); } finally { this.ownership.close(); }
  }
}
