import {test} from "node:test";import assert from "node:assert/strict";
import {mergeSourceChecklists} from "./source-checklists.mjs";
const empty={medicine:[],woundCare:[],followUps:[],additional:[],contactPhysician:[]};
const med={name:"Aspirin",strength:null,dose:null,frequency:"daily",instructions:null};
test("source merge retains PDF items when transcript only contains aspirin",()=>{
 const plan=mergeSourceChecklists([{source:"PDF",checklist:{...empty,medicine:[{...med,name:"Documented medication"}],followUps:["Visit clinic"]}},{source:"Transcript",checklist:{...empty,medicine:[{...med,frequency:"as needed"}]}}]);
 assert.equal(plan.medicine.length,2);assert.deepEqual(plan.followUps,["Visit clinic"]);
});
test("conflicting source medicine doses are flagged, never silently overridden",()=>{
 const plan=mergeSourceChecklists([{source:"PDF",checklist:{...empty,medicine:[{...med,dose:"1 tablet"}]}},{source:"Transcript",checklist:{...empty,medicine:[{...med,dose:"2 tablets"}]}}]);
 assert.equal(plan.medicine[0].dose,null);assert.match(plan.medicine[0].instructions,/REVIEW REQUIRED.*1 tablet.*2 tablets/);
});
