const path = 'd:/project/ai/codeshell/bun.lock';
const fs = require('fs');
const text = fs.readFileSync(path, 'utf8');
// remove trailing commas
const cleaned = text.replace(/,(\s*[}\]])/g, '\');
try {
  const json = JSON.parse(cleaned);
  console.log('OK, packages:', Object.keys(json.packages).length);
} catch(e) {
  console.log('Error:', e.message);
}
