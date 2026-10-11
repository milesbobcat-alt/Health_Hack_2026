import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildMedicationComparison,comparisonSentences,fhirBaseline,mergeTransitionSources,separateDose,validateComparison,validateTransitions} from './medication-comparison.mjs';
const med=(name,fields={})=>({name,formulation:null,strength:null,dose:null,frequency:null,instructions:null,sources:[],...fields});
const groups=(fields={})=>({before:[],continue:[],begin:[],stop:[],...fields});
const comparison=(baseline=[],actions={})=>({patient:null,baseline,groups:groups(actions),warnings:[]});
test('FHIR history keeps only named medicines, multiple dosages, and no invented tablet count',()=>{
 const result=fhirBaseline([{name:'Not documented',dosages:[]},{name:'Medication',dosages:[]},{name:'Aspirin',strength:'Not documented',labelStrength:'81 mg',dosages:[{dose:'81 mg',timing:'daily',text:'Take as prescribed',asNeeded:'Yes'},{dose:'Not documented',timing:'Not documented',text:'Second instruction'}]}]);
 assert.equal(result.length,1);assert.equal(result[0].strength,'81 mg');assert.equal(result[0].dose,null);assert.match(result[0].instructions,/81 mg/);assert.match(result[0].instructions,/Second instruction/);assert.deepEqual(result[0].sources,['FHIR']);
});
test('explicit prior fields override FHIR, while after directions never overwrite before',()=>{
 const result=buildMedicationComparison(comparison([med('Atorvastatin',{strength:'20 mg',dose:'1 tablet',frequency:'twice weekly',sources:['FHIR']})],{
 before:[med('Atorvastatin',{dose:'2 tablets',sources:['PDF']})],continue:[med('Atorvastatin',{strength:'40 mg',dose:'1 tablet',frequency:'daily',sources:['Transcript']})]}));
 assert.equal(result.length,1);assert.equal(result[0].before.dose,'2 tablets');assert.equal(result[0].before.strength,'20 mg');assert.equal(result[0].before.frequency,'twice weekly');assert.equal(result[0].after.strength,'40 mg');assert.equal(result[0].action,'begin');assert.equal(result[0].unverified,false);
});
test('FHIR-only history never implies discharge action and stays explicitly unverified',()=>{
 const row=buildMedicationComparison(comparison([med('Aspirin',{dose:'1 tablet',sources:['FHIR']})]))[0];
 assert.equal(row.unverified,true);assert.equal(row.action,null);assert.equal(comparisonSentences(row).after,'Discharge information not provided');
});
test('rows align and sort begin, continue, stop, then unknown; stop omits regimen',()=>{
 const result=buildMedicationComparison(comparison([med('Old'),med('Unmentioned'),med('Same',{dose:'1 tablet'})],{begin:[med('New',{strength:'20 mg'})],continue:[med('Same',{dose:'1 tablet'})],stop:[med('Old',{strength:'500 mg'})]}));
 assert.deepEqual(result.map(row=>row.identity.name),['New','Same','Old','Unmentioned']);
 assert.equal(comparisonSentences(result[0]).before,'Prior medication information not provided');assert.match(comparisonSentences(result[1]).after,/Continue taking Same/);assert.equal(comparisonSentences(result[2]).after,'Stop taking Old.');
});
test('formulations remain distinct, and normalized product names match explicit formulations',()=>{
 const result=buildMedicationComparison(comparison([med('Metoprolol 20 mg Oral Tablet'),med('Metoprolol 20 mg Oral Capsule')],{continue:[med('Metoprolol',{formulation:'tablet',dose:'1 tablet'})],stop:[med('Metoprolol',{formulation:'capsule'})]}));
 assert.equal(result.length,2);assert.equal(result.filter(row=>row.action==='stop').length,1);assert.equal(result.filter(row=>row.action==='continue').length,1);
});
test('conflicting explicit prior values and discharge actions flag review without selecting a winner',()=>{
 const result=buildMedicationComparison(comparison([med('Aspirin',{dose:'1 tablet'})],{before:[med('Aspirin',{dose:'2 tablets',sources:['PDF']}),med('Aspirin',{dose:'3 tablets',sources:['Transcript']})],continue:[med('Aspirin',{dose:'1 tablet'})],stop:[med('Aspirin')]}));
 assert.equal(result[0].before.dose,null);assert.match(result[0].before.instructions,/2 tablets versus 3 tablets/);assert.equal(result[0].action,'unknown');assert.match(comparisonSentences(result[0]).after,/REVIEW REQUIRED/);
});
test('strength is never copied to dose; total amounts are preserved without calculating units',()=>{
 assert.deepEqual(separateDose(med('Example',{strength:'40 mg',dose:'40 mg'})).dose,null);
 assert.match(separateDose(med('Example',{dose:'40 mg'})).instructions,/Documented total amount: 40 mg/);
 assert.equal(separateDose(med('Example',{strength:'40 mg',dose:'2 tablets'})).dose,'2 tablets');
});
test('transition validation rejects malformed records and tags source provenance',()=>{
 assert.throws(()=>validateTransitions(groups({before:[med(null)]})),/require a name/);
 assert.throws(()=>validateTransitions(groups({begin:[med('A',{dose:2})]})),/Invalid medication dose/);
 assert.throws(()=>validateComparison({...comparison(),patient:{id:'x',server:'https://elsewhere'}},'https://configured'),/Invalid comparison patient/);
 const result=mergeTransitionSources([{source:'PDF',checklist:{medicationTransitions:groups({before:[med('A')]})}},{source:'Transcript',checklist:{medicationTransitions:groups({begin:[med('B')]})}}]);
 assert.deepEqual(result.before[0].sources,['PDF']);assert.deepEqual(result.begin[0].sources,['Transcript']);
});

import {reclassifyChangedRegimens} from './medication-comparison.mjs';
test('changed continue regimens are persisted in begin, not just labeled begin in the table',()=>{
 const value=comparison([med('A',{dose:'1 tablet'})],{continue:[med('A',{dose:'2 tablets'})]});
 reclassifyChangedRegimens(value);assert.equal(value.groups.continue.length,0);assert.equal(value.groups.begin.length,1);
});

test('equivalent daily/unit wording is not incorrectly classified as a changed regimen',()=>{
 const result=buildMedicationComparison(comparison([med('Example',{strength:'20 mg / 1 tablet',dose:'1 tablet',frequency:'1 time every 1 day'})],{continue:[med('Example',{strength:'20mg',dose:'one tablet',frequency:'daily'})]}));
 assert.equal(result[0].action,'continue');
});
test('different frequency remains a regimen change and PRN wording is not equated to scheduled use',()=>{
 const result=buildMedicationComparison(comparison([med('Example',{frequency:'daily'})],{continue:[med('Example',{frequency:'daily as needed'})]}));
 assert.equal(result[0].action,'begin');
});
