// Builds docs/mockup/orrery-ui.html: the app's real stylesheet and script, inlined, driven by stub.js instead of a server.
//   node docs/mockup/build.mjs
// The UI is plain ES modules (packages/server/public/js). A single HTML file cannot import files, so the modules are
// joined here: each becomes a function that returns its exports, in dependency order. No other transformation.
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, posix } from 'node:path';
import { fileURLToPath } from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const pub = join(here, '../../packages/server/public');
const read = (p) => readFileSync(p, 'utf8');
const inline = (code) => code.replace(/<\/script/g, '<\\/script');

/** Join the module graph that starts at `entry` (a path under public/) into one classic script. */
function bundle(entry) {
  const done = new Map(); // module path -> code, in the order they must run
  const visit = (path) => {
    if (done.has(path)) return;
    done.set(path, null); // (the UI has no import cycles; this only guards against endless recursion)
    const names = [];
    let code = read(join(pub, path))
      .replace(/^import\s+\{([^}]*)\}\s+from\s+'([^']+)';\s*$/gm, (_, list, from) => {
        const dep = posix.join(posix.dirname(path), from);
        visit(dep);
        return `const {${list.replace(/(\w+)\s+as\s+(\w+)/g, '$1: $2')}} = __modules[${JSON.stringify(dep)}];`;
      })
      .replace(/^export\s+((?:async\s+)?function\s*\*?|const|let|class)\s+([\w$]+)/gm, (_, kind, name) => {
        names.push(name);
        return `${kind} ${name}`;
      });
    if (/^\s*(import|export)\b/m.test(code)) throw new Error(`${path}: an import/export form this builder does not know`);
    done.delete(path);
    done.set(path, `__modules[${JSON.stringify(path)}] = (() => {\n${code}\nreturn { ${names.join(', ')} };\n})();`);
  };
  visit(entry);
  return `'use strict';\nconst __modules = {};\n${[...done.values()].join('\n')}`;
}

const page = read(join(pub, 'index.html'))
  .replace('<title>Orrery</title>', '<title>Orrery UI mock-up</title>')
  .replace('<link rel="stylesheet" href="/app.css">', () => `<style>\n${read(join(pub, 'app.css'))}</style>`)
  .replace('<script type="module" src="/js/main.js"></script>', () => `<script>\n${inline(read(join(here, 'stub.js')))}</script>\n<script>\n${inline(bundle('js/main.js'))}</script>`);
if (!page.includes('__modules')) throw new Error('index.html no longer has the script tag this builder replaces');
writeFileSync(join(here, 'orrery-ui.html'), page);
console.log('wrote', join(here, 'orrery-ui.html'));
