import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist',{recursive:true});
for(const file of ['edgelight-card.js','edgelight.css','display-model.js']) {
  await copyFile('web/'+file,'dist/'+file);
}
await mkdir('dist/vendor',{recursive:true});
await copyFile('web/vendor/lit-core.min.js','dist/vendor/lit-core.min.js');
console.log('Built dist/edgelight-card.js, display-model.js, edgelight.css and vendor/lit-core.min.js');
