import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import vm from 'node:vm';
import {patientPlainText} from './medication-plan.mjs';
const page=readFileSync(new URL('./ptView.html',import.meta.url),'utf8');
function render(warnings){
 const section={hidden:true}; const list={children:[],replaceChildren(...items){this.children=items;}};
 const document={querySelector:selector=>selector==='.warning-section'?section:list,createElement:tag=>({tag,set innerHTML(value){throw Error('Unsafe text');}})};
 const begin=page.indexOf('function renderWarnings()');const end=page.indexOf('function showChecklistCategory',begin);
 vm.runInNewContext(page.slice(begin,end)+'renderWarnings();',{document,patientPlainText,checklist:{contactPhysician:warnings}});
 return {section,list};
}
test('patient warnings retain urgency and safely render plain text without checkboxes',()=>{
 const warnings=['Call 911 for severe chest pain','Call your physician for swelling','<script>literal text</script>'];
 const {section,list}=render(warnings);assert.equal(section.hidden,false);
 assert.deepEqual(list.children.map(item=>item.textContent),warnings);assert.ok(list.children.every(item=>item.tag==='li'));
 assert.doesNotMatch(page,/id="contactPhysician-tab"/);
});
test('empty warnings remain hidden and AVS follows the sidebar at full width',()=>{
 assert.equal(render([]).section.hidden,true);
 assert.ok(page.indexOf('class="patient-section avs-section"')>page.indexOf('</aside>'));
 assert.match(page,/\.avs-section \{ grid-column: 1 \/ -1/);
});
