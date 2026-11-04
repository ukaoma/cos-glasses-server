/* Owner review, source refresh and outcome evidence use the same versioned RPC. */
(function(){
  'use strict';
  window.createMemoryStewardship=function(api){
    var state={tab:'rules',rows:[],cursor:null,busy:false,error:null,intent:null,serial:0,open:false,draft:{}};
    var esc=api.esc;
    function request(body){return api.call('workspace.request',body);}
    function field(id){var e=document.getElementById(id);return e?e.value.trim():'';}
    function button(label,action,id){return '<button '+(state.busy||(state.intent&&action!=='retry')?'disabled':'')+' data-steward-action="'+action+'" data-steward-id="'+esc(id||'')+'">'+label+'</button>';}
    function saveDraft(){['stewardText','stewardTrigger','stewardExclusions','stewardEvidence','stewardEvaluation'].forEach(function(id){var e=document.getElementById(id);if(e)state.draft[id]=e.value;});}
    function render(){
      if(!state.open)return;saveDraft();
      var body='<p>Evidence and owner decisions govern changes. A saved rule stays in shadow until reviewed and independently checked.</p><div class="actions">'+['rules','sources','outcomes'].map(function(t){return button(t==='rules'?'Standing rules':t==='sources'?'Current sources':'Outcome evidence','tab',t);}).join('')+'</div>';
      if(state.error)body+='<p class="bad">'+esc(state.error)+'</p>'+(state.intent?button('Retry same action','retry'):button('Reload','reload'));
      if(state.busy)body+='<p>Working…</p>';
      if(state.tab==='rules'){
        body+=state.rows.map(function(r){var p=r.payload||{};
          return '<section class="logrow"><h3>'+esc(p.text)+'</h3><p>'+esc(r.state)+' · revision '+esc(r.revision)+' · '+esc(p.review)+'</p><p>Applies when: '+esc(p.trigger||'not specified')+'</p><p>Exclusions: '+esc((p.exclusions||[]).join('; ')||'none recorded')+'</p><small>Evidence: '+esc((p.evidence_refs||[]).join(', '))+'</small><div class="actions">'+(r.state==='candidate'&&p.review!=='approved_by_owner'?button('Review this version','review',r.id):'')+(r.state==='candidate'&&p.review==='approved_by_owner'?button('Check evaluation and activate','activate',r.id):'')+(r.state==='active'?button('Roll back this rule','rollback',r.id):'')+'</div></section>';
        }).join('')||'<p>No standing-rule versions recorded.</p>';
        if(state.cursor)body+=button('Load more','more');
        body+='<div class="settings-block"><h3>Propose a rule</h3><textarea class="editor" id="stewardText" placeholder="The proposed behavior"></textarea><input id="stewardTrigger" placeholder="When this rule applies"><input id="stewardExclusions" placeholder="Exclusions, one per line"><input id="stewardEvidence" placeholder="Source or memory IDs, separated by commas">'+button('Save shadow proposal','propose')+'</div><div class="settings-block"><label>Independent evaluation ID <input id="stewardEvaluation" placeholder="Evaluation artifact ID"></label><p class="muted">Checks must cover this exact revision, trigger, exclusions, counterexamples and regressions. An unverified artifact cannot activate a rule.</p></div>';
      }else if(state.tab==='sources'){
        body+=state.rows.map(function(r){return '<section class="logrow"><h3>'+esc(r.title||r.id)+'</h3><p>Revision '+esc(r.revision)+' · '+esc(r.captured_at)+' · '+esc(r.projection)+'</p><small>'+esc(r.content_hash)+'</small>'+button('Refresh granted document','refresh',r.id)+'</section>';}).join('')||'<p>No current granted source snapshots. Source grants are configured by the instance owner.</p>';
      }else{
        var d=state.outcomes||{};body+='<p>'+esc(d.unique_runs||0)+' observed runs. Evidence threshold '+(d.evidence_gate_met?'met':'not yet met')+'.</p><pre>'+esc(JSON.stringify(d,null,2))+'</pre><p>Retrieval, context inclusion, model-reported application and independently checked outcomes are distinct. Insufficient evidence does not imply improvement.</p>';
      }
      api.modal('Memory stewardship',body);
      Object.keys(state.draft).forEach(function(id){var e=document.getElementById(id);if(e)e.value=state.draft[id];});
      document.querySelectorAll('[data-steward-action]').forEach(function(el){el.addEventListener('click',function(){act(el.dataset.stewardAction,el.dataset.stewardId);});});
    }
    function load(more){
      if(state.busy)return;state.busy=true;state.error=null;var serial=++state.serial;
      var action=state.tab==='rules'?'rule_page':state.tab==='sources'?'source_status':'trace_summary';var body={action:action};
      if(action==='rule_page'){body.limit=25;body.cursor=more?state.cursor:null;}
      render();request(body).then(function(d){if(serial!==state.serial||!state.open)return;state.busy=false;
        if(action==='trace_summary')state.outcomes=d;else{state.rows=more?state.rows.concat(d.items||[]):d.items||[];state.cursor=d.next_cursor||null;}
        render();},function(e){if(serial!==state.serial||!state.open)return;state.busy=false;state.error=e.message;render();});
    }
    function mutate(body){
      if(state.busy||!state.open)return;if(state.intent&&body!==state.intent)return;if(!state.intent)state.intent=JSON.parse(JSON.stringify(body));
      state.busy=true;state.error=null;render();request(state.intent).then(function(d){
        state.busy=false;state.intent=null;if(state.open){api.toast(d.status||'Saved');load(false);}
      },function(e){state.busy=false;state.error=/evaluation_not_found/.test(e.message)?'No passing evaluation was found for this ID. The rule is still in shadow. Check the evaluation result and enter a valid ID.':/evaluation_unreadable/.test(e.message)?'This evaluation could not be verified. The rule is still in shadow. Regenerate the evaluation before retrying.':e.message;
        if(/revision_conflict|idempotency_conflict|invalid_|rule_not_|evaluation_|owner_review_required|not_memory_authority/.test(e.message))state.intent=null;
        render();});
    }
    function act(action,id){
      if(state.busy||!state.open)return;
      if(state.intent&&action!=='retry'){state.error='Retry the pending action before starting another.';render();return;}
      if(action==='retry'){mutate(state.intent);return;}
      if(action==='tab'){if(state.intent){state.error='Resolve the pending action before changing sections.';render();return;}state.tab=id;state.rows=[];state.cursor=null;load(false);return;}
      if(action==='reload'){load(false);return;}if(action==='more'){load(true);return;}
      if(action==='propose'){
        mutate({action:'propose_rule',payload:{lesson_id:'owner_proposal',text:field('stewardText'),trigger:field('stewardTrigger'),exclusions:field('stewardExclusions').split('\n').filter(Boolean),evidence_refs:field('stewardEvidence').split(',').map(function(x){return x.trim();}).filter(Boolean)}});return;
      }
      var row=state.rows.find(function(r){return r.id===id;});if(!row)return;
      var body={action:action==='refresh'?'refresh_source':action==='review'?'review_rule':action==='rollback'?'rollback_rule':'activate_rule',id:id,expected_revision:row.revision,idempotency_key:'steward_'+crypto.randomUUID()};
      if(action==='activate'){body.evaluation_id=field('stewardEvaluation');if(!body.evaluation_id){state.error='Enter the independent evaluation ID for this reviewed revision.';render();return;}}
      mutate(body);
    }
    return {open:function(){state.open=true;if(state.intent){render();return;}load(false);},close:function(){saveDraft();state.open=false;++state.serial;if(!state.intent)state.busy=false;}};
  };
})();
