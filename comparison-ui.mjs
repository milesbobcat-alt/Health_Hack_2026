import {buildMedicationComparison,comparisonSentences,comparisonFields,transitionKeys} from './medication-comparison.mjs';
const editorIds = new WeakMap();
let editorCount = 0;
export function comparisonReadAloud(comparison) {
 return buildMedicationComparison(comparison).map(row=>{const text=comparisonSentences(row);return `${text.before}${row.unverified ? ' FHIR history is unverified.' : ''} ${text.after}${row.warning ? ` ${row.warning}` : ''}`;}).join('\n');
}
export function renderComparison(container,comparison,{editable=false,onChange=()=>{}}={}) {
 container.replaceChildren();
 if (!comparison) {container.hidden=true;return;}
 container.hidden=false;
 const heading=document.createElement('h2');heading.textContent='Medication Comparison';
 container.append(heading);
 for(const warning of comparison.warnings || []) {const p=document.createElement('p');p.textContent=warning;p.setAttribute('role','status');container.append(p);}
 const wrapper=document.createElement('div');wrapper.className='comparison-scroll';wrapper.tabIndex=0;
 const table=document.createElement('table');table.className='comparison-table';
 const caption=document.createElement('caption');caption.textContent='Medication changes for nurse review';caption.className='visually-hidden';table.append(caption);
 const head=document.createElement('thead');const headRow=document.createElement('tr');
 for(const text of ['Before','After']){const th=document.createElement('th');th.scope='col';th.textContent=text;headRow.append(th);}head.append(headRow);table.append(head);
 const body=document.createElement('tbody');
 const rows=buildMedicationComparison(comparison);
 if(!rows.length){const tr=document.createElement('tr');const td=document.createElement('td');td.colSpan=2;td.textContent='No named medication information available.';tr.append(td);body.append(tr);}
 for(const row of rows) {
  const tr=document.createElement('tr');const sentences=comparisonSentences(row);
  for(const side of ['before','after']) {
   const td=document.createElement('td');const text=document.createElement('p');text.textContent=sentences[side];td.append(text);
   const sources=row[side]?.sources || [];
   if(sources.length){const provenance=document.createElement('small');provenance.textContent=`Source: ${sources.join(' + ')}${side==='before' && row.unverified ? ' — unverified history' : ''}`;td.append(provenance);}
   if(row.warning){const warning=document.createElement('p');warning.className='comparison-warning';warning.textContent=row.warning;td.append(warning);}
   tr.append(td);
  }body.append(tr);
 }table.append(body);wrapper.append(table);container.append(wrapper);
 if(!editable)return;
 const details=document.createElement('details');const summary=document.createElement('summary');summary.textContent='Review or edit medication groups';details.append(summary);
 const addEditor=(list,title)=>{
  const section=document.createElement('section');const h=document.createElement('h3');h.textContent=title;section.append(h);
  list.forEach((med,index)=>{
   const fieldset=document.createElement('fieldset');fieldset.className='comparison-editor';const legend=document.createElement('legend');legend.textContent=med.name;fieldset.append(legend);
   for(const field of comparisonFields) {
    const label=document.createElement('label');label.textContent=field[0].toUpperCase()+field.slice(1);
    const input=document.createElement('input');input.type='text';input.value=med[field] || '';input.placeholder='Not documented';
    if(!editorIds.has(med))editorIds.set(med,++editorCount);
    input.id=`comparison-field-${editorIds.get(med)}-${field}`;input.required=field==='name';
    input.addEventListener('input',()=>{
      if(field==='name' && !input.value.trim()){input.setCustomValidity('A medication name is required.');input.reportValidity();return;}
      input.setCustomValidity('');med[field]=input.value.trim() || null;med.sources=[...new Set([...(med.sources || []),'Nurse review'])];onChange(comparison);
    });label.append(input);fieldset.append(label);
   }
   const remove=document.createElement('button');remove.type='button';remove.textContent='Remove';remove.addEventListener('click',()=>{list.splice(index,1);onChange(comparison);});fieldset.append(remove);section.append(fieldset);
  });
  const add=document.createElement('button');add.type='button';add.textContent=`Add ${title.toLowerCase()} medication`;
  add.addEventListener('click',()=>{list.push({name:'New medication',formulation:null,strength:null,dose:null,frequency:null,instructions:null,sources:['Nurse review']});onChange(comparison);});section.append(add);details.append(section);
 };
 addEditor(comparison.baseline,'FHIR baseline');
 for(const key of transitionKeys)addEditor(comparison.groups[key],key);
 container.append(details);
}
