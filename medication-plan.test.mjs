import {test} from "node:test";
import assert from "node:assert/strict";
import {editMedication, medicationText, isMedication} from "./medication-plan.mjs";
test("legacy medication wording is retained only as instructions", () => {
 const item = editMedication("Take the old prescription with food.");
 assert.equal(item.name, null); assert.equal(item.dose, null); assert.equal(item.instructions, "Take the old prescription with food.");
 assert.equal(isMedication(item), true);
 assert.match(medicationText(item), /Strength: Not documented/);
 assert.match(medicationText(item), /Take the old prescription with food/);
});
test("dose and strength stay separate in display and speech, including optional PRN wording", () => {
 const item = {name: "Example", strength: "10 mg per tablet", dose: "2 tablets", frequency: null, instructions: "As needed for documented symptom"};
 const text = medicationText(item); assert.match(text, /Strength: 10 mg per tablet/); assert.match(text, /Dose: 2 tablets/);
 assert.match(text, /Frequency: Not documented/); assert.match(text, /As needed/);
 assert.equal(isMedication({...item, extra: "unsupported"}), false);
});

import {editWoundCare, isWoundCare, woundCareText} from "./medication-plan.mjs";
test("legacy wound care retains wording and never infers frequency", () => {
 const item=editWoundCare("Change dressing daily");assert.equal(item.frequency,null);assert.equal(isWoundCare(item),true);
 assert.match(woundCareText(item),/Frequency: Not documented/);assert.match(woundCareText(item),/Change dressing daily/);
 assert.equal(isWoundCare({...item,frequency:2}),false);
 assert.equal(woundCareText({instructions:"Clean incision",frequency:"daily"}),"Clean incision. Frequency: daily");
});


import {patientMedicationText,patientWoundCareText} from './medication-plan.mjs';
import {renderPatientCategory} from './patient-render-test-helper.mjs';
test('patient medicine sentence keeps strength and units distinct in display and speech',()=>{
 const med={name:'Furosemide',strength:'25 mg',dose:'1 tablet',frequency:'twice daily',instructions:null};
 const expected='Take one 25 mg tablet of Furosemide twice a day.';
 assert.equal(patientMedicationText(med),expected);
 assert.match(renderPatientCategory({medicine:[med]},'medicine'),/Take one 25 mg tablet of Furosemide twice a day/);
});
test('patient sentence preserves PRN conditions, source warnings, legacy wording and missing fields',()=>{
 const med={name:'Aspirin',strength:null,dose:null,frequency:'as needed',instructions:'Only for pain; do not exceed the documented daily limit'};
 assert.match(patientMedicationText(med),/Dose not documented/);
 assert.match(patientMedicationText(med),/Only for pain\. Do not exceed/);
 assert.doesNotMatch(patientMedicationText(med),/one tablet/);
 assert.equal(patientMedicationText('Stop taking aspirin.'),'Stop taking aspirin.');
 const hold={...med,strength:'81 mg',dose:'1 tablet',instructions:'Hold if blood pressure is low'};
 assert.match(patientMedicationText(hold),/Hold if blood pressure is low/);
 assert.doesNotMatch(patientMedicationText(hold),/^Take/);
 assert.match(patientMedicationText({...med,instructions:'REVIEW REQUIRED: conflicting instructions'}),/Confirm the dose and schedule/);
});
test('wound care uses short sentences without discarding frequency',()=>{
 assert.equal(patientWoundCareText({instructions:'Clean the incision',frequency:'daily'}),'Clean the incision. Do this daily.');
 assert.equal(patientWoundCareText({instructions:'Clean daily.',frequency:'daily'}),'Clean daily.');
 assert.match(patientWoundCareText({instructions:'Keep the wound dry',frequency:null}),/Frequency not documented/);
});


test('conflicting Metoprolol shows a short review message for objects and legacy field strings',()=>{
 const instructions='continue as before; for rate control; REVIEW REQUIRED: conflicting instructions — strength: earlier source says "50 mg"; PDF says "75 mg"; REVIEW REQUIRED: conflicting instructions — frequency: earlier source says "once daily"; PDF says "at the discharge dose"';
 const med={name:'Metoprolol succinate',strength:null,dose:'1 tablet',frequency:null,instructions};
 const expected='Metoprolol succinate: Confirm the dose and schedule with your care team.';
 assert.equal(patientMedicationText(med),expected);
 assert.equal(patientMedicationText(medicationText(med)),expected);
 assert.equal(med.instructions,instructions);
 assert.doesNotMatch(expected,/50 mg|75 mg|Take/);
 assert.match(renderPatientCategory({medicine:[med]},'medicine'),/Confirm the dose and schedule/);
});
import {patientPlainText} from './medication-plan.mjs';
test('patient sentence capitalization preserves numbers, limits, and conditions',()=>{
 assert.equal(patientPlainText('for heart; take with food. call if dizzy.'),'For heart. Take with food. Call if dizzy.');
 assert.equal(patientPlainText('take 2.5 mg as needed for pain'),'Take 2.5 mg as needed for pain');
});
