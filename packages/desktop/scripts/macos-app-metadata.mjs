/** Read modes, symlink targets, and exact xattr/resource-fork bytes on macOS. */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";

export function captureMacosAppMetadata(app, home) {
  assert.equal(process.platform, "darwin");
  assert.equal(realpathSync(app), app);
  assert.equal(realpathSync(home), home);
  // Xcode's Python does not expose os.listxattr on macOS. Use the native
  // read-only ABI with XATTR_NOFOLLOW so framework links never escape the tree.
  const source = `import os,sys,json,hashlib,stat,ctypes
lib=ctypes.CDLL(None,use_errno=True)
lib.listxattr.argtypes=[ctypes.c_char_p,ctypes.c_void_p,ctypes.c_size_t,ctypes.c_int]
lib.listxattr.restype=ctypes.c_ssize_t
lib.getxattr.argtypes=[ctypes.c_char_p,ctypes.c_char_p,ctypes.c_void_p,ctypes.c_size_t,ctypes.c_uint32,ctypes.c_int]
lib.getxattr.restype=ctypes.c_ssize_t
def checked(value):
 if value<0:
  code=ctypes.get_errno(); raise OSError(code,os.strerror(code))
 return value
def attributes(file):
 path=os.fsencode(file)
 size=checked(lib.listxattr(path,None,0,1))
 if size==0:return []
 names=ctypes.create_string_buffer(size)
 size=checked(lib.listxattr(path,names,size,1))
 result=[]
 for name in sorted(item for item in names.raw[:size].split(b'\\0') if item):
  length=checked(lib.getxattr(path,name,None,0,0,1))
  value=ctypes.create_string_buffer(length)
  length=checked(lib.getxattr(path,name,value,length,0,1))
  result.append([os.fsdecode(name),hashlib.sha256(value.raw[:length]).hexdigest()])
 return result
root=sys.argv[1]; rows=[]
def visit(file,rel):
 s=os.lstat(file)
 rows.append([rel,stat.S_IMODE(s.st_mode),os.readlink(file) if stat.S_ISLNK(s.st_mode) else None,attributes(file)])
 if stat.S_ISDIR(s.st_mode):
  for entry in sorted(os.scandir(file),key=lambda item:item.name): visit(entry.path,rel+'/'+entry.name)
visit(root,'.')
print(json.dumps(rows,ensure_ascii=True,separators=(',',':')))
`;
  const bytes = execFileSync("/usr/bin/python3", ["-c", source, app], {
    timeout: 120_000,
    maxBuffer: 8 * 1024 * 1024,
    env: { PATH: "/usr/bin:/bin", HOME: home },
  });
  return {
    sha256: createHash("sha256").update(bytes).digest("hex"),
    records: JSON.parse(bytes),
  };
}
