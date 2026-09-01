import { mkdirSync, readdirSync, readFileSync, writeFileSync, unlinkSync, statSync } from 'fs';
import { createHash } from 'crypto';
import { join } from 'path';

// The device is the only copy of a show. It carries the scene and overlay builds, every bank
// name, the transition set and the graphics — and a factory reset or a firmware update wipes all
// of it with no confirmation and no export. rcv-api already pulls the whole <RcvShow> XML every
// 30 s to read bank names out of it, so archiving that dump costs one file write per real change
// and turns "the switcher lost everything" from unrecoverable into a diff.
//
// This is a RECORD, not a restore path: the RCV exposes no OSC verb that loads a show back, so a
// snapshot is read to rebuild the show by hand (or to prove what a slot used to be called).

const KEEP = 60;

// What is on program, what is on preview and the mtime change every time a button is pressed, so
// hashing the dump verbatim would archive a fresh copy every 30 s all through a show and push the
// last pre-incident snapshot out of the window within the hour. They are live state, not the show
// — strip them before deciding whether anything actually changed. The file still stores the
// original text.
const VOLATILE = /\s(last_modified|Pgm(Scene|Overlay)|Pvw(Scene|Overlay))="[^"]*"/g;

export class ShowStore {
  constructor(dir) {
    this.dir = dir;
    this.lastHash = null;
    mkdirSync(dir, { recursive: true });
    // Re-seed the hash from the newest snapshot so a service restart does not write a duplicate.
    const newest = this.list()[0];
    if (newest) this.lastHash = hash(readFileSync(join(dir, newest.file), 'utf8'));
  }

  // Written only when the content actually changed — the 30 s poll would otherwise archive the
  // same show 2,880 times a day.
  archive(xmlText) {
    const h = hash(xmlText);
    if (h === this.lastHash) return null;
    this.lastHash = h;

    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const name = /name="([^"]*)"/.exec(xmlText)?.[1]?.replace(/[^\w-]+/g, '_') || 'show';
    const file = `${stamp}_${name}.xml`;
    writeFileSync(join(this.dir, file), xmlText, 'utf8');

    for (const old of this.list().slice(KEEP)) {
      try { unlinkSync(join(this.dir, old.file)); } catch { /* already gone */ }
    }
    return file;
  }

  /** Newest first. */
  list() {
    let files;
    try { files = readdirSync(this.dir); } catch { return []; }
    return files
      .filter((f) => f.endsWith('.xml'))
      .sort()
      .reverse()
      .map((file) => ({ file, bytes: statSync(join(this.dir, file)).size }));
  }

  read(file) {
    // Snapshots are addressed by name from list(); anything with a path separator is not one.
    if (!/^[\w.-]+\.xml$/.test(file)) return null;
    try { return readFileSync(join(this.dir, file), 'utf8'); } catch { return null; }
  }
}

const hash = (s) => createHash('sha1').update(s.replace(VOLATILE, '')).digest('hex');
