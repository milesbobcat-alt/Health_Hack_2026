import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import vm from 'node:vm';
import {renderComparison,comparisonReadAloud} from './comparison-ui.mjs';
import {validateComparison,separateDose,reclassifyChangedRegimens} from './medication-comparison.mjs';
import {medicationFields,isMedication,editMedication,woundFields,isWoundCare,editWoundCare} from './medication-plan.mjs';
class Element {
 constructor(tag='div'){this.tag=tag;this.children=[];this.listeners={};this.dataset={};this.value='';this.files=[];this.disabled=false;this.hidden=true;this.classList={add(){}};}
 set innerHTML(value){throw new Error('External text must not use innerHTML');}
 append(...items){this.children.push(...items);}
 replaceChildren(...items){this.children=items;}
 setAttribute(key,value){this[key]=value;}
 removeAttribute(key){delete this[key];}
 addEventListener(key,handler){this.listeners[key]=handler;}
 querySelectorAll(){return [];}
 querySelector(){return null;}
 scrollIntoView(){} focus(){} select(){} setCustomValidity(){} reportValidity(){}
 get text(){return [this.textContent || '',...this.children.map(node=>node.text)].join(' ');}
}
const item={name:'Aspirin',formulation:null,strength:'81 mg',dose:'1 tablet',frequency:'daily',instructions:null,sources:['FHIR']};
const comparison={patient:null,baseline:[item],groups:{before:[],begin:[],continue:[],stop:[{...item,sources:['PDF']}]},warnings:[]};
test('comparison table aligns before/after, labels provenance, renders external text safely, and reads stop without dose',()=>{
 const old=globalThis.document;globalThis.document={createElement:tag=>new Element(tag)};
 try{
  const container=new Element();renderComparison(container,{...comparison,baseline:[{...item,name:'<script>external</script>'}],groups:{...comparison.groups,stop:[{...item,name:'<script>external</script>',sources:['PDF']}]}});
  const wrapper=container.children.find(node=>node.className==='comparison-scroll');const table=wrapper.children[0];const body=table.children.find(node=>node.tag==='tbody');
  assert.equal(container.children[0].textContent,'Medication Comparison');assert.doesNotMatch(container.text,/Before uses provisional/);assert.equal(body.children.length,1);assert.equal(body.children[0].children.length,2);assert.match(body.text,/FHIR — unverified history/);assert.match(body.text,/<script>external<\/script>/);
  assert.match(comparisonReadAloud(comparison),/Took Aspirin/);assert.match(comparisonReadAloud(comparison),/Stop taking Aspirin\./);
 }finally{globalThis.document=old;}
});
function nurseHarness(){
 const nodes=new Map();let pending;let options;
 const document={querySelector:key=>{if(!nodes.has(key))nodes.set(key,new Element());return nodes.get(key);},querySelectorAll:()=>[],createElement:tag=>new Element(tag),addEventListener(){}};
 const script=fs.readFileSync(new URL('./nurseIntake.html',import.meta.url),'utf8').match(/<script type="module">([\s\S]*?)<\/script>/)[1].replace(/^\s*import .*;$/gm,'');
 const context={document,initializePatientViewer:opts=>{options=opts;return {selected:{server:'https://fhir.example/r4',patient:{id:'omar'}}};},renderComparison:(box,value)=>{box.hidden=!value;},validateComparison,separateDose,reclassifyChangedRegimens,medicationFields,isMedication,editMedication,woundFields,isWoundCare,editWoundCare,AbortController,FormData,window:{},navigator:{},console,URL,fetch:async()=>new Promise(resolve=>{pending=resolve;})};
 vm.runInNewContext(script,context);
 document.querySelector('#stop-recording').disabled=true;document.querySelector('#start-recording').disabled=false;document.querySelector('#emr-text').value='Notes';
 return {nodes,document,get resolve(){return pending;},get options(){return options;}};
}
const response={ok:true,headers:{get:()=>null},json:async()=>({checklist:{medicine:[],woundCare:[],followUps:['Call clinic'],additional:[],contactPhysician:[]},medicationComparison:comparison})};
for(const change of ['patient','source'])test(`delayed generation cannot restore comparison after ${change} changes`,async()=>{
 const harness=nurseHarness();const promise=harness.document.querySelector('#generate-checklist').listeners.click();
 assert.equal(typeof harness.resolve,'function');
 if(change==='patient')harness.options.clearDraft();else harness.document.querySelector('#emr-text').listeners.input();
 harness.resolve(response);await promise;
 assert.equal(harness.document.querySelector('#medication-comparison').hidden,true);assert.equal(harness.document.querySelector('#checklist-review').hidden,true);
});

test('comparison input edits update their actual stored record and notify review callback',()=>{
 const old=globalThis.document;globalThis.document={createElement:tag=>new Element(tag)};
 try {
  const value={...comparison,baseline:comparison.baseline.map(item=>({...item})),groups:{...comparison.groups,stop:comparison.groups.stop.map(item=>({...item}))}};
  const container=new Element();let notified=0;renderComparison(container,value,{editable:true,onChange:()=>notified++});
  const descendants=node=>[node,...node.children.flatMap(descendants)];
  const input=descendants(container).find(node=>node.id?.endsWith('-dose'));
  input.value='2 tablets';input.listeners.input();assert.equal(value.baseline[0].dose,'2 tablets');assert.equal(notified,1);assert.ok(value.baseline[0].sources.includes('Nurse review'));
 } finally {globalThis.document=old;}
});
