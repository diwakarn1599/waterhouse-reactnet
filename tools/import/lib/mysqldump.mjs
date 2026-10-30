// Minimal reader for the `INSERT INTO ... VALUES (...),(...);` statements a
// mysqldump produces. Deliberately not a general SQL parser - it understands
// exactly the subset mysqldump emits, and throws on anything it does not
// recognise rather than guessing.

/**
 * Parse one MySQL tuple list, e.g. "(1,'a',NULL),(2,'b',3.5)".
 * Returns an array of arrays of JS values (string | number | null).
 */
function parseTuples(text, startIndex, tableForErrors) {
  const rows = [];
  let i = startIndex;
  const n = text.length;

  const skipWs = () => { while (i < n && /\s/.test(text[i])) i++; };

  while (i < n) {
    skipWs();
    if (text[i] !== '(') {
      throw new Error(`${tableForErrors}: expected "(" at offset ${i}, found ${JSON.stringify(text.slice(i, i + 40))}`);
    }
    i++; // consume (

    const row = [];
    while (i < n) {
      skipWs();

      if (text[i] === "'") {
        // Quoted string. mysqldump escapes with backslashes.
        i++;
        let out = '';
        while (i < n) {
          const c = text[i];
          if (c === '\\') {
            const e = text[i + 1];
            switch (e) {
              case '0':  out += '\0'; break;
              case 'n':  out += '\n'; break;
              case 'r':  out += '\r'; break;
              case 't':  out += '\t'; break;
              case 'b':  out += '\b'; break;
              case 'Z':  out += '\x1a'; break;
              case '\\': out += '\\'; break;
              case "'":  out += "'"; break;
              case '"':  out += '"'; break;
              default:   out += e; break;
            }
            i += 2;
            continue;
          }
          if (c === "'") {
            // Doubled '' is also a literal quote in some dumps.
            if (text[i + 1] === "'") { out += "'"; i += 2; continue; }
            i++;
            break;
          }
          out += c;
          i++;
        }
        row.push(out);
      } else {
        // NULL, number, or bare literal, terminated by , or )
        let start = i;
        while (i < n && text[i] !== ',' && text[i] !== ')') i++;
        const raw = text.slice(start, i).trim();
        if (raw.toUpperCase() === 'NULL') {
          row.push(null);
        } else if (raw === '') {
          row.push(null);
        } else {
          const num = Number(raw);
          row.push(Number.isNaN(num) ? raw : num);
        }
      }

      skipWs();
      if (text[i] === ',') { i++; continue; }
      if (text[i] === ')') { i++; break; }
      throw new Error(`${tableForErrors}: expected "," or ")" at offset ${i}`);
    }

    rows.push(row);

    skipWs();
    if (text[i] === ',') { i++; continue; }
    if (text[i] === ';') { i++; break; }
    if (i >= n) break;
    throw new Error(`${tableForErrors}: expected "," or ";" at offset ${i}`);
  }

  return { rows, endIndex: i };
}

/**
 * Extract every row inserted into `tableName`, keyed by column name.
 * Handles a dump that splits one table across several INSERT statements.
 */
export function readTable(dumpText, tableName) {
  const out = [];
  // mysqldump writes either `INSERT INTO `t` (`a`,`b`) VALUES` or `INSERT INTO `t` VALUES`
  const re = new RegExp(
    'INSERT\\s+INTO\\s+`' + tableName + '`\\s*(\\(([^)]*)\\))?\\s*VALUES',
    'gi'
  );

  let m;
  while ((m = re.exec(dumpText)) !== null) {
    const columnList = m[2];
    if (!columnList) {
      throw new Error(
        `${tableName}: dump uses INSERT without an explicit column list; ` +
        `cannot map values to columns safely.`
      );
    }
    const columns = columnList
      .split(',')
      .map(c => c.trim().replace(/^`|`$/g, ''));

    const { rows, endIndex } = parseTuples(dumpText, re.lastIndex, tableName);
    for (const values of rows) {
      if (values.length !== columns.length) {
        throw new Error(
          `${tableName}: row has ${values.length} values but ${columns.length} columns`
        );
      }
      const obj = {};
      for (let c = 0; c < columns.length; c++) obj[columns[c]] = values[c];
      out.push(obj);
    }
    re.lastIndex = endIndex;
  }

  return out;
}

/** Column names declared in the dump's CREATE TABLE for `tableName`. */
export function readColumns(dumpText, tableName) {
  const re = new RegExp('CREATE\\s+TABLE\\s+`' + tableName + '`\\s*\\(([\\s\\S]*?)\\n\\)\\s*ENGINE', 'i');
  const m = re.exec(dumpText);
  if (!m) return [];
  return m[1]
    .split('\n')
    .map(l => l.trim())
    .filter(l => l.startsWith('`'))
    .map(l => l.slice(1, l.indexOf('`', 1)));
}
