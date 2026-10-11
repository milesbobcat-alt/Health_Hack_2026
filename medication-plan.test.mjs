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
