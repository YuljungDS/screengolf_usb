const fs=require('fs');
let h=fs.readFileSync(__dirname+'/shell.html','utf8');
const strip=s=>s.replace(/\nif \(typeof module[^\n]*\n?/,'\n');
h=h.replace('/*PHYSICS*/',()=>strip(fs.readFileSync(__dirname+'/physics.js','utf8')))
 .replace('/*SPINTEX*/',()=>strip(fs.readFileSync(__dirname+'/spintex.js','utf8')))
 .replace('/*DETECTOR*/',()=>strip(fs.readFileSync(__dirname+'/detector.js','utf8')))
 .replace('/*APP*/',()=>fs.readFileSync(__dirname+'/app.js','utf8'));
fs.mkdirSync('/home/claude/dist',{recursive:true});
fs.writeFileSync(__dirname+'/../app/src/main/assets/www/index.html',h);
console.log('built',h.length);
