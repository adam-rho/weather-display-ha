import {mkdir,copyFile} from 'node:fs/promises';
await mkdir('dist',{recursive:true});
for(const file of ['edgelight-card.js','edgelight.css','display-model.js']) {
  await copyFile('web/'+file,'dist/'+file);
}
console.log('Built dist/edgelight-card.js, display-model.js and edgelight.css');
