import {readFileSync} from "node:fs";
import vm from "node:vm";
import {patientMedicationText,patientMedicationNeedsReview,patientPlainText,patientWoundCareText} from "./medication-plan.mjs";
// Exercise the actual page renderer with a small DOM double; never invoke services.
export function renderPatientCategory(checklist,category) {
 const source=readFileSync(new URL("./ptView.html",import.meta.url),"utf8");
 const begin=source.indexOf("function showChecklistCategory(category)");
 const end=source.indexOf("checklistTabs.forEach((tab, index)",begin);
 class Node {
  constructor(){this.children=[];this.textContent="";this.dataset={};}
  append(...children){this.children.push(...children);}
  replaceChildren(...children){this.children=children;}
  querySelectorAll(){return [];}
  setAttribute(){}
  get text(){return [this.textContent,...this.children.map(node=>node.text)].join(" ");}
 }
 const list=new Node();
 const context={document:{createElement:()=>new Node()},checklist,checklistItems:list,checklistTabs:[],categories:[],checkedItems:Object.fromEntries(Object.keys(checklist).map(key=>[key,[]])),activeCategory:category,patientMedicationText,patientMedicationNeedsReview,patientPlainText,patientWoundCareText};
 vm.runInNewContext(source.slice(begin,end)+`showChecklistCategory(${JSON.stringify(category)});`,context);
 return list.text;
}
