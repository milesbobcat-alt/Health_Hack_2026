export function createQuestionStore({storage,key,idGenerator=()=>crypto.randomUUID()}) {
 let questions=[];
 try {
  const saved=JSON.parse(storage.getItem(key) || '[]');
  if(Array.isArray(saved)) questions=saved.filter(item=>item && typeof item.id==='string' && typeof item.text==='string' && item.text.trim() && item.text.length<=2000).slice(0,100);
 } catch {} // A blocked or invalid browser store must not prevent writing questions.
 function persist(){try{storage.setItem(key,JSON.stringify(questions));return true;}catch{return false;}}
 return {
  list:()=>questions.map(item=>({...item})),
  add(text){text=text.trim();if(!text)throw Error('Write a question first.');if(text.length>2000)throw Error('Keep your question under 2,000 characters.');if(questions.length>=100)throw Error('Remove an old question before adding another.');questions.push({id:idGenerator(),text});return persist();},
  remove(id){questions=questions.filter(item=>item.id!==id);return persist();},
 };
}
export function initializePatientQuestions({document,storage,dischargeId}) {
 const form=document.querySelector('#question-form');const input=document.querySelector('#follow-up-questions');
 const button=document.querySelector('#save-question');const list=document.querySelector('#previous-questions');
 const history=document.querySelector('#question-history');const status=document.querySelector('#question-status');
 if(!dischargeId){button.disabled=true;return;}
 const store=createQuestionStore({storage,key:`carepack:questions:${dischargeId}`});
 function render(){
  const questions=store.list();history.hidden=!questions.length;
  list.replaceChildren(...questions.map(question=>{
   const item=document.createElement('li');const text=document.createElement('p');text.textContent=question.text;
   const remove=document.createElement('button');remove.type='button';remove.textContent='Remove';remove.setAttribute('aria-label',`Remove question: ${question.text}`);
   remove.addEventListener('click',()=>{const saved=store.remove(question.id);render();status.textContent=saved?'Question removed.':'Question removed for this visit. Browser storage is unavailable.';button.focus();});
   item.append(text,remove);return item;
  }));
 }
 form.addEventListener('submit',event=>{
  event.preventDefault();
  try{const saved=store.add(input.value);input.value='';render();status.textContent=saved?'Question saved on this browser.':'Question saved for this visit. Browser storage is unavailable.';input.focus();}
  catch(error){status.textContent=error.message;input.focus();}
 });
 render();
}
