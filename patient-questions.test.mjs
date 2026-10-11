import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createQuestionStore,initializePatientQuestions} from './patient-questions.mjs';
const memory=()=>{const values=new Map();return {getItem:key=>values.get(key),setItem:(key,value)=>values.set(key,value)};};
test('questions persist across reloads, remove individually, and stay isolated by patient link',()=>{
 const storage=memory();let count=0;const options={storage,key:'first',idGenerator:()=>String(++count)};
 const store=createQuestionStore(options);store.add('First question');store.add('Second question');
 const restored=createQuestionStore(options);assert.equal(restored.list().length,2);restored.remove('1');
 assert.deepEqual(createQuestionStore(options).list().map(item=>item.text),['Second question']);
 assert.deepEqual(createQuestionStore({...options,key:'other'}).list(),[]);
});
test('blank questions are rejected and blocked/corrupt browser storage preserves usable current-session questions',()=>{
 const store=createQuestionStore({key:'a',storage:{getItem(){throw Error();},setItem(){throw Error();}},idGenerator:()=> 'id'});
 assert.throws(()=>store.add('   '),/Write a question/);assert.equal(store.add('Question'),false);assert.equal(store.list().length,1);
 assert.equal(store.remove('id'),false);assert.equal(store.list().length,0);
 const corrupted=createQuestionStore({key:'a',storage:{getItem:()=>'{bad'}});assert.deepEqual(corrupted.list(),[]);
});
test('patient question UI saves safe text, clears input, and removes the selected question',()=>{
 class Node {constructor(){this.children=[];this.listeners={};this.value='';}set innerHTML(value){throw Error('Unsafe text');}append(...items){this.children.push(...items);}replaceChildren(...items){this.children=items;}setAttribute(){}focus(){}addEventListener(type,fn){this.listeners[type]=fn;}}
 const nodes=new Map();const document={querySelector:key=>{if(!nodes.has(key))nodes.set(key,new Node());return nodes.get(key);},createElement:()=>new Node()};
 initializePatientQuestions({document,storage:memory(),dischargeId:'demo'});
 const input=nodes.get('#follow-up-questions');input.value='<script>literal question</script>';
 nodes.get('#question-form').listeners.submit({preventDefault(){}});
 assert.equal(input.value,'');const list=nodes.get('#previous-questions');assert.equal(list.children[0].children[0].textContent,'<script>literal question</script>');
 list.children[0].children[1].listeners.click();assert.equal(list.children.length,0);assert.equal(nodes.get('#question-history').hidden,true);
});
