import type { Db } from '../db.ts';

/**
 * The platform tables, created on start. `create ... if not exists` only, so a
 * v2 database upgrades in place and nothing it held is touched.
 *
 * The audit log, the event log and approved documents are protected by
 * triggers: SQLite refuses an UPDATE or DELETE on them. A trigger does not stop
 * someone who can edit the file directly — that is what the hash chains and the
 * signed checkpoints are for — but it stops every code path in this server.
 */
export const PLATFORM_SCHEMA_VERSION = 1;

export function migratePlatform(db: Db): void {
  db.exec(`
    create table if not exists platform_meta (key text primary key, value text not null);

    create table if not exists users (
      id text primary key,
      username text not null unique collate nocase,
      display_name text not null,
      password_hash text,
      totp_secret text,
      totp_pending text,
      totp_last_step integer,
      idp text not null default 'local',
      idp_subject text,
      disabled integer not null default 0,
      created_at integer not null,
      updated_at integer not null
    );

    create table if not exists grants (
      id text primary key,
      user_id text not null,
      position text not null,
      scope text not null,
      unit text,
      granted_by text not null,
      granted_at integer not null,
      revoked_at integer,
      revoked_by text
    );
    create index if not exists grants_user on grants (user_id) where revoked_at is null;

    create table if not exists sessions (
      id text primary key,
      token_hash text not null unique,
      user_id text not null,
      kind text not null,
      csrf text not null,
      stage text not null,
      created_at integer not null,
      last_seen_at integer not null,
      expires_at integer not null,
      revoked_at integer,
      revoked_reason text
    );
    create index if not exists sessions_user on sessions (user_id);

    create table if not exists display_grants (
      id text primary key,
      scope text not null,
      label text not null,
      code_hash text not null,
      code_expires_at integer not null,
      paired_at integer,
      created_by text not null,
      created_at integer not null,
      revoked_at integer
    );

    create table if not exists audit_log (
      seq integer primary key,
      at integer not null,
      actor_user text,
      actor_name text,
      actor_position text,
      action text not null,
      target text,
      outcome text not null,
      detail text not null,
      prev_hash text not null,
      hash text not null
    );
    create trigger if not exists audit_log_append_only_update before update on audit_log
      begin select raise(abort, 'audit_log is append-only'); end;
    create trigger if not exists audit_log_append_only_delete before delete on audit_log
      begin select raise(abort, 'audit_log is append-only'); end;

    create table if not exists audit_checkpoints (
      seq integer primary key,
      hash text not null,
      at integer not null,
      key_id text not null,
      public_key text not null,
      signature text not null
    );

    create table if not exists streams (
      id text primary key,
      scope text not null,
      mode text not null,
      created_at integer not null,
      created_by text not null
    );

    create table if not exists events (
      seq integer primary key,
      id text not null unique,
      stream text not null,
      type text not null,
      actor_user text not null,
      actor_position text not null,
      server_time integer not null,
      client_time text,
      sim_time real,
      mode text not null,
      caused_by text,
      payload text not null,
      audience text,
      content_hash text not null,
      prev_hash text not null,
      hash text not null
    );
    create index if not exists events_stream on events (stream, seq);
    create trigger if not exists events_append_only_update before update on events
      begin select raise(abort, 'events is append-only'); end;
    create trigger if not exists events_append_only_delete before delete on events
      begin select raise(abort, 'events is append-only'); end;

    create table if not exists assignments (
      id text primary key,
      stream text not null,
      version integer not null,
      state text not null,
      updated_seq integer not null
    );
    create table if not exists acknowledgements (
      assignment_id text not null,
      version integer not null,
      user_id text not null,
      event_seq integer not null,
      primary key (assignment_id, version, user_id)
    );

    create table if not exists documents (
      id text not null,
      version integer not null,
      kind text not null,
      scope text not null,
      name text not null,
      status text not null,
      classification text not null,
      revision integer not null,
      author_user text not null,
      author_name text not null,
      author_position text,
      created_at integer not null,
      updated_at integer not null,
      reviewed_by text,
      approved_by text,
      parent_version integer,
      body text not null,
      body_hash text not null,
      imported_from text,
      primary key (id, version)
    );
    create index if not exists documents_kind on documents (kind, scope);
    create trigger if not exists documents_approved_immutable before update on documents when old.status = 'approved'
      begin select raise(abort, 'approved document versions are immutable'); end;
    create trigger if not exists documents_approved_undeletable before delete on documents when old.status = 'approved'
      begin select raise(abort, 'approved document versions are immutable'); end;

    create table if not exists comparisons_v3 (
      id text primary key,
      scope text not null,
      json text not null,
      created_at integer not null
    );

    create table if not exists outbound_allowlist (
      host text primary key,
      ports text not null,
      https_only integer not null,
      note text not null,
      added_by text not null,
      added_at integer not null
    );

    create table if not exists feed_cache (
      url text primary key,
      status integer,
      etag text,
      last_modified text,
      expires_at integer,
      fetched_at integer,
      body text,
      failures integer not null default 0,
      next_attempt_at integer not null default 0,
      last_error text
    );
    create table if not exists feed_snapshots (
      feed text primary key,
      json text not null,
      updated_at integer not null
    );
  `);
  db.prepare('insert or ignore into platform_meta (key, value) values (?, ?)').run('schema_version', String(PLATFORM_SCHEMA_VERSION));
}

const open = new WeakSet<Db>();

/** `node:sqlite` has no transaction helper: one BEGIN/COMMIT, ROLLBACK on any throw. Nested calls join the outer one. */
export function transaction<T>(db: Db, fn: () => T): T {
  if (open.has(db)) return fn();
  db.exec('BEGIN IMMEDIATE');
  open.add(db);
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    open.delete(db);
  }
}
