import {mkdir,readFile,writeFile} from "node:fs/promises";import {join,resolve} from "node:path";import {fileURLToPath} from "node:url";import {auditSchema,type Audit} from "@spectra/schemas";
const root=resolve(fileURLToPath(new URL("../../../",import.meta.url)));const dir=process.env.SPECTRA_DATA_DIR||join(root,".spectra","audits");
export async function saveAudit(a:Audit){await mkdir(dir,{recursive:true});await writeFile(join(dir,`${a.id}.json`),JSON.stringify(a,null,2),{encoding:"utf8",flag:"wx"}).catch(async e=>{if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;});}
export async function getAudit(id:string){if(!/^[a-f0-9-]{36}$/.test(id))return null;try{return auditSchema.parse(JSON.parse(await readFile(join(dir,`${id}.json`),"utf8")))}catch{return null}}
