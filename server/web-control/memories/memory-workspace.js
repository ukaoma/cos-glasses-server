/* Owner-only investigations. Canvas edits are drafts; assertions have their own explicit save. */
(function () {
  'use strict';
  var MAX_NODES=200,MAX_EDGES=500;
  function id(){return crypto.randomUUID();}
  function copy(value){return JSON.parse(JSON.stringify(value));}
  function endpoint(value){return typeof value==='object'?value.id:value;}
  function mergeCanvas(old, incoming){
    var nodes=new Map((old.nodes||[]).map(function(n){return [n.id,n];}));
    var links=new Map((old.links||[]).map(function(l){return [l.id||endpoint(l.source)+'|'+endpoint(l.target),l];}));
    (incoming.nodes||[]).forEach(function(n){nodes.set(n.id,Object.assign({},n,nodes.has(n.id)?{x:nodes.get(n.id).x,y:nodes.get(n.id).y,fx:nodes.get(n.id).fx,fy:nodes.get(n.id).fy}:{}));});
    (incoming.links||[]).forEach(function(l){links.set(l.id||endpoint(l.source)+'|'+endpoint(l.target),Object.assign({},l,{source:endpoint(l.source),target:endpoint(l.target)}));});
    if(nodes.size>MAX_NODES||links.size>MAX_EDGES)throw new Error('Canvas limit reached (200 points / 500 links). Hide a branch or start another investigation.');
    return {nodes:Array.from(nodes.values()),links:Array.from(links.values())};
  }
  function create(options){
    var el=document.createElement('section');el.className='memory-investigation';
    var state={id:id(),revision:0,title:'Untitled investigation',nodes:[],links:[],anchors:[],waypoints:[],filters:{hops:3,direction:'undirected',avoid:[]},generation:null,paths:[]};
    var queuedFocus=null,editEpoch=0,lastFocus=null,selected=null,offsets={},history=[],controller=null,started=false,busy=false,requestSerial=0,saveIntents={},assertionIntent=null,separationIntent=null;
    el.innerHTML='<div data-role="canvas" class="cgx-host"></div><p data-role="overview-status" class="muted" role="status"></p><details class="investigation-tools" data-role="advanced"><summary>Advanced investigation</summary><div class="graph-search row"><input type="search" id="graphQuery" aria-label="Find an entity" placeholder="Find a person or idea…"><button onclick="cosApp.graphSearch()">Find points</button><span id="graphSearchStatus" class="muted"></span></div><div class="source-card"><div class="row"><input data-role="title" aria-label="Investigation title" placeholder="Investigation title"><button data-action="save">Save investigation</button><button data-action="open">Open saved</button><button data-action="new">New</button></div>'+
      '<p data-role="receipt" class="muted">Draft · saved separately from standing knowledge.</p><div data-role="matches" class="row"></div>'+
      '<div class="row"><b data-role="selected">Select a point</b><button data-action="start">Set start</button><button data-action="target">Set target</button><button data-action="waypoint">Add waypoint</button><button data-action="expand">Expand point</button><button data-action="avoid">Avoid point</button><button data-action="hide">Hide point</button><button data-action="undo">Undo canvas edit</button></div>'+
      '<p data-role="anchors"></p><div data-role="waypoints" class="row"></div><div class="row"><label>Total hops <select data-role="hops" aria-label="Total hop limit"><option>3</option><option>4</option><option>5</option><option>6</option><option>7</option></select></label><label>Traversal <select data-role="direction" aria-label="Relationship direction"><option value="undirected">Undirected discovery</option><option value="directed">Known direction only</option></select></label><label>Known valid on <input data-role="valid" aria-label="Known valid on" type="date"></label><button data-action="paths">Find connections</button><button data-action="refresh">Review generation changes</button><button data-action="separate">Keep anchors separate</button></div>'+
      '<p class="muted">Searches the full index. Up to 3 alternatives, 25 neighbors per expansion. Legacy connections have unknown direction and validity. Paths show associations; they do not establish correlation or causation.</p>'+
      '<div class="row"><input data-role="point" aria-label="New idea name" placeholder="Add your own idea"><button data-action="point">Add idea</button><input data-role="rationale" aria-label="Association rationale" placeholder="Why might start and target relate?"><button data-action="hypothesis">Add draft hypothesis</button><button data-action="assertion">Save as my assertion</button></div>'+
      '<p data-role="status" role="status" aria-live="polite"></p><div data-role="paths"></div><div data-role="saved"></div></div></details>';
    function role(name){return el.querySelector('[data-role="'+name+'"]');}
    function userIntent(){editEpoch++;if(options.onUserIntent)options.onUserIntent();}
    var legacyMode=false;
    function status(text){role('status').textContent=text;}
    function snapshot(){
      if(controller){var snap=controller.snapshot();state.nodes=snap.nodes;state.links=snap.links;state.positions=snap.positions;}
      state.title=role('title').value||'Untitled investigation';
      state.filters.hops=Number(role('hops').value);state.filters.direction=role('direction').value;state.filters.valid_at=role('valid').value||null;
      return copy(state);
    }
    function remember(){editEpoch++;history.push(snapshot());if(history.length>30)history.shift();}
    function selectedChanged(value){selected=value;role('selected').textContent=value;}
    function draw(){
      if(selected && !state.nodes.some(function(n){return n.id===selected;}))selected=null;
      role('selected').textContent=selected||'Select a point';
      role('title').value=state.title;
      role('hops').value=String(state.filters.hops);role('direction').value=state.filters.direction;role('valid').value=state.filters.valid_at||'';
      role('anchors').textContent='Start: '+(state.anchors[0]||'—')+' → Target: '+(state.anchors[1]||'—')+' · Avoid: '+(state.filters.avoid.join(', ')||'none');
      role('waypoints').replaceChildren();
      state.waypoints.forEach(function(point,index){
        var label=document.createElement('span');label.textContent=(index+1)+'. '+point+' ';role('waypoints').appendChild(label);
        [['↑',-1],['↓',1],['Remove',0]].forEach(function(pair){var b=document.createElement('button');b.textContent=pair[0];b.setAttribute('aria-label',pair[0]+' waypoint '+point);b.onclick=function(){remember();if(!pair[1])state.waypoints.splice(index,1);else{var target=index+pair[1];if(target<0||target>=state.waypoints.length)return;var temp=state.waypoints[target];state.waypoints[target]=point;state.waypoints[index]=temp;}draw();};label.appendChild(b);});
      });
      if(controller)controller.replaceData(state);
      else controller=COSGraphExplorer.mount(role('canvas'),Object.assign({},options.graphOptions||{},{scope:'actual',data:state,status:'ready',focus:state.focus||state.anchors[0],onUserIntent:userIntent,onSelect:function(value){userIntent();selectedChanged(value);},
        onRecenter:function(value){userIntent();selectedChanged(value);run(function(){return expand(value);});},
        onPassages:function(value){run(async function(){options.openPassages(value,await options.call('graph.passages',{entity:value,limit:5}));});},
        labels:Object.assign({},options.graphOptions&&options.graphOptions.labels,{sourceStatus:'Draft ideas and hypotheses stay in this investigation until explicitly saved as assertions.',emptyTitle:'No points to show yet',emptyMessage:'Ask a question or open Advanced investigation to find a point. An empty knowledge index needs documents first.'})}));
      if(options.onController)options.onController(controller);
      drawPaths();
    }
    function drawPaths(){
      role('paths').replaceChildren();
      state.paths.forEach(function(path,index){
        var box=document.createElement('details'),title=document.createElement('summary');title.textContent='Path '+(index+1)+': '+path.nodes.join(' → ');box.appendChild(title);
        path.edges.forEach(function(edge){
          var p=document.createElement('p');p.textContent=endpoint(edge.source)+' → '+endpoint(edge.target)+' · '+(edge.direction||'unknown')+' · '+(edge.evidence_status||'unknown')+' · '+(edge.description||edge.desc||'No relationship description');
          var button=document.createElement('button');button.textContent='Inspect hop evidence';button.onclick=function(){
            if(edge.evidence_status==='user_authored'||edge.evidence_status==='hypothesis'){status('User rationale: '+(edge.description||edge.desc||'None supplied')+' · '+(edge.evidence_refs||[]).length+' cited references.');return;}
            run(async function(){options.openPassages(endpoint(edge.source)+' / '+endpoint(edge.target),await options.call('graph.passages',{source:endpoint(edge.source),target:endpoint(edge.target),limit:5}));});
          };p.appendChild(button);box.appendChild(p);
        });role('paths').appendChild(box);
      });
    }
    async function rpc(action,args){
      var result=await options.call('workspace.request',Object.assign({action:action,request_id:id()},args||{}));
      if(result.error){var code=typeof result.error==='object'?result.error.code:result.error;var message=code==='generation_changed'?'Knowledge changed. Choose Review generation changes before continuing.':code==='revision_conflict'?'This record changed. Refresh and review the latest revision before saving.':typeof result.error==='object'?(result.error.message||result.error.code):result.error;var error=new Error(message);error.code=code;throw error;}
      if(result.protocol!==1)throw new Error('This workspace needs the matching server and memory pipeline protocol.');
      return result;
    }
    async function run(work){
      if(busy){status('The current operation is still running.');return;}
      busy=true;el.setAttribute('aria-busy','true');el.querySelectorAll('input,select').forEach(function(n){n.disabled=true;});status('Working…');
      try{await work();}catch(error){status(error.message);options.toast(error.message);}finally{busy=false;if(role('status').textContent==='Working…')status('Ready.');el.removeAttribute('aria-busy');el.querySelectorAll('input,select').forEach(function(n){n.disabled=false;});if(queuedFocus){var focus=queuedFocus;queuedFocus=null;lastFocus=focus;selectedChanged(focus);run(function(){return expand(focus);});}}
    }
    async function expand(value){
      if(legacyMode)return expandLegacy(value);
      var response=await rpc('graph_expand',{id:value,offset:offsets[value]||0,generation:state.generation});
      var canvas=mergeCanvas(snapshot(),response);remember();state.nodes=canvas.nodes;state.links=canvas.links;state.generation=response.generation;offsets[value]=response.next_offset;
      draw();status(response.next_offset!=null?'Added neighbors. Expand again for the next page.':'All neighbors loaded for this point.');
    }
    async function expandLegacy(value){
      var legacy=await options.call('graph.entity',{id:value,limit:25});
      if(!legacy.found)throw new Error('Entity not found in the legacy graph. Choose another point.');
      var nodes=[{id:legacy.id,group:legacy.type||'unknown',description:legacy.description,descs:legacy.descriptions||[],totalDegree:legacy.degree}].concat((legacy.neighbors||[]).map(function(n){return {id:n.id,group:n.type||'unknown',totalDegree:n.degree};}));
      var canvas=mergeCanvas(snapshot(),{nodes:nodes,links:legacy.edges||[]});remember();state.nodes=canvas.nodes;state.links=canvas.links;
      draw();status('Legacy graph browsing. Reload after updating the server and memory pipeline to use advanced actions.');
    }
    function showMatches(items){
      role('advanced').open=true;
      role('matches').replaceChildren();
      items.forEach(function(item){var b=document.createElement('button');b.textContent=item.id+' · '+(item.type||'unknown');b.onclick=function(){selectedChanged(item.id);run(function(){return expand(item.id);});};role('matches').appendChild(b);});
    }
    function point(){
      var name=role('point').value.trim();if(!name)throw new Error('Enter an idea name.');if(state.nodes.some(function(n){return n.id===name;}))throw new Error('That point is already on the canvas.');
      var data=mergeCanvas(snapshot(),{nodes:[{id:name,group:'concept',description:'User-authored draft idea.',evidence_status:'hypothesis',direction:'unknown',validity:'unknown'}]});remember();state.nodes=data.nodes;selectedChanged(name);draw();status('Idea added to this draft investigation.');
    }
    async function association(persist){
      var source=state.anchors[0],target=state.anchors[1],description=role('rationale').value.trim();
      if(!source||!target||source===target||!description)throw new Error('Choose different start and target points and supply a rationale.');
      var intentBody=JSON.stringify({source:source,target:target,description:description,direction:role('direction').value});
      if(persist&&(!assertionIntent||assertionIntent.body!==intentBody))assertionIntent={body:intentBody,id:id()};
      var edge={id:persist?assertionIntent.id:id(),source:source,target:target,description:description,direction:role('direction').value,validity:'unknown',evidence_status:persist?'user_authored':'hypothesis'};
      mergeCanvas(snapshot(),{links:[edge]});
      if(persist){var receipt=await rpc('save_assertion',{id:edge.id,expected_revision:0,idempotency_key:edge.id,payload:{source:source,target:target,description:description,direction:edge.direction}});role('receipt').textContent='Assertion saved · operation '+receipt.operation_id;/* Keep the prior generation pinned until the user reviews all concurrent overlay changes. */assertionIntent=null;}
      remember();state.links=mergeCanvas(snapshot(),{links:[edge]}).links;draw();status(persist?'Saved as your assertion. Review generation changes before extending this investigation.':'Hypothesis added to the draft; standing knowledge is unchanged.');
    }
    async function save(){
      var current=snapshot(),payload={};['title','anchors','waypoints','nodes','links','positions','filters','generation','paths'].forEach(function(k){if(current[k]!==undefined)payload[k]=current[k];});
      var pending=saveIntents[state.id];var recovering=!!pending;if(!pending)pending=saveIntents[state.id]={body:JSON.stringify(payload),key:id(),revision:state.revision};
      var receipt=await rpc('save_exploration',{id:state.id,expected_revision:pending.revision,idempotency_key:pending.key,payload:JSON.parse(pending.body)});
      state.revision=receipt.revision;delete saveIntents[state.id];role('receipt').textContent='Saved revision '+receipt.revision+' · operation '+receipt.operation_id;status(recovering?'Previous save recovered. Save again to include any subsequent edits.':'Investigation saved. Reopen it after restart.');
    }
    async function open(cursor){
      var response=await rpc('list_explorations',{cursor:cursor||null});if(!cursor)role('saved').replaceChildren();
      if(!response.items.length){status('No saved investigations yet.');return;}
      response.items.forEach(function(row){var button=document.createElement('button');button.textContent=row.title+' · revision '+row.revision;button.onclick=function(){run(async function(){var loaded=await rpc('get_exploration',{id:row.id});row=loaded.item;remember();history=[];role('saved').replaceChildren();state=Object.assign({filters:{hops:3,direction:'undirected',avoid:[]},paths:[],anchors:[],waypoints:[]},copy(row.payload),{id:row.id,revision:row.revision});state.filters.avoid=state.filters.avoid||[];offsets={};selected=null;draw();role('receipt').textContent='Opened revision '+row.revision+' · '+row.operation_id;status('Saved evidence generation retained. Review generation changes before extending.');});};role('saved').appendChild(button);});if(response.next_cursor){var more=document.createElement('button');more.textContent='More investigations';more.onclick=function(){run(function(){return open(response.next_cursor);});};role('saved').appendChild(more);}status('Choose an investigation to reopen.');
    }
    async function paths(){
      if(!state.anchors[0]||!state.anchors[1]||state.anchors[0]===state.anchors[1])throw new Error('Choose different start and target points first.');
      var filters={hops:Number(role('hops').value),direction:role('direction').value,avoid:state.filters.avoid,valid_at:role('valid').value||null};
      var response=await rpc('graph_paths',Object.assign({start:state.anchors[0],target:state.anchors[1],waypoints:state.waypoints,generation:state.generation},filters));
      var canvas=mergeCanvas(snapshot(),response);remember();state.nodes=canvas.nodes;state.links=canvas.links;state.paths=response.paths;state.generation=response.generation;state.filters=filters;draw();status(response.message+(response.truncated?' · Incomplete: '+response.truncation_reason:' · Complete within the selected limits.'));
    }
    async function refresh(){
      var before=snapshot(),previewEpoch=editEpoch;var response=await rpc('graph_resolve',{nodes:before.nodes,links:before.links});
      var message=document.createElement('p');message.textContent='Generation '+JSON.stringify(state.generation)+' → '+JSON.stringify(response.generation)+'. '+response.changes.length+' changes: '+(response.changes.map(function(c){return c.kind+' '+c.id;}).join('; ')||'No changed visible evidence.');
      var apply=document.createElement('button');apply.textContent='Apply reviewed generation';apply.onclick=function(){if(state.id!==before.id||editEpoch!==previewEpoch){role('saved').replaceChildren();status('Investigation changed. Review generation changes again.');return;}var current=snapshot();remember();state.nodes=response.nodes.map(function(n){var old=current.nodes.find(function(x){return x.id===n.id;});return Object.assign({},n,old?{x:old.x,y:old.y,fx:old.fx,fy:old.fy}:{});});state.links=response.links;state.generation=response.generation;state.paths=[];offsets={};draw();role('saved').replaceChildren();status('Current evidence applied. Withdrawn links removed; missing endpoints labeled. Anchors retained.');};role('saved').replaceChildren(message,apply);status('Review evidence changes below before applying.');
    }
    async function separate(){
      var source=state.anchors[0],target=state.anchors[1],before=state.id,epoch=editEpoch;
      if(!source||!target||source===target)throw new Error('Choose different start and target points first.');
      var body=JSON.stringify([source,target]),response=await rpc('identity_status',{source:source,target:target});
      if(before!==state.id||epoch!==editEpoch)return;
      role('saved').replaceChildren();
      if(response.same_identity){status('These names already share one identity. Review a split before keeping them separate.');return;}
      if(response.blocked){status('These identities are already protected from merging: '+response.blocked);return;}
      if(!response.writable){status('Save identity constraints on the memory owner Mac after memory setup.');return;}
      if(!separationIntent||separationIntent.body!==body)separationIntent={body:body,key:id(),revision:response.revision};
      var intent=separationIntent,message=document.createElement('p'),apply=document.createElement('button');
      message.textContent='Keep “'+source+'” and “'+target+'” as distinct identities, including their known aliases. Connections between them remain available.';
      apply.textContent='Save separation rule';apply.onclick=function(){run(async function(){
        if(before!==state.id||epoch!==editEpoch||body!==JSON.stringify(state.anchors.slice(0,2))){role('saved').replaceChildren();status('The anchors changed. Review the separation rule again.');return;}
        try{
          var receipt=await rpc('identity_keep_apart',{source:source,target:target,expected_revision:intent.revision,idempotency_key:intent.key});
          separationIntent=null;role('saved').replaceChildren();role('receipt').textContent='Separation rule saved · operation '+receipt.operation_id;
          status('These identities and their aliases are now protected from merging. Review generation changes before finding connections.');
        }catch(error){
          if(['revision_conflict','identity_split_required','idempotency_conflict'].includes(error.code)){separationIntent=null;role('saved').replaceChildren();}
          throw error;
        }
      });};role('saved').replaceChildren(message,apply);status('Review the two identities before saving.');
    }
    el.addEventListener('click',function(event){if(event.target.closest('button'))userIntent();if(busy&&event.target.closest('button')){event.preventDefault();event.stopImmediatePropagation();status('The current operation is still running.');}},true);
    el.addEventListener('click',function(event){var button=event.target.closest('[data-action]');if(!button||!el.contains(button))return;var action=button.dataset.action;
      run(async function(){
        if(['start','target','waypoint','expand','avoid','hide'].includes(action)&&!selected)throw new Error('Select a point on the canvas first.');
        if(action==='save')return save();if(action==='open')return open();if(action==='paths')return paths();if(action==='refresh')return refresh();if(action==='separate')return separate();if(action==='point')return point();if(action==='hypothesis'||action==='assertion')return association(action==='assertion');
        if(action==='expand'){if(offsets[selected]===null){status('All neighbors for this point are already loaded.');return;}return expand(selected);}
        if(action==='undo'){if(!history.length){status('No canvas edits to undo.');return;}editEpoch++;role('saved').replaceChildren();var previous=history.pop();['nodes','links','positions','anchors','waypoints','filters','generation','paths'].forEach(function(key){state[key]=previous[key];});draw();status('Canvas edit undone. Saved assertions are unchanged.');return;}
        remember();
        if(action==='start')state.anchors[0]=selected;
        if(action==='target')state.anchors[1]=selected;
        if(action==='waypoint'){if(state.waypoints.includes(selected)||state.anchors.includes(selected))throw new Error('That point is already an anchor or waypoint.');if(state.waypoints.length>=6)throw new Error('At most six waypoints fit the seven-hop budget.');state.waypoints.push(selected);}
        if(action==='avoid'&&!state.filters.avoid.includes(selected))state.filters.avoid.push(selected);
        if(action==='hide'){state.nodes=state.nodes.filter(function(n){return n.id!==selected;});state.links=state.links.filter(function(l){return endpoint(l.source)!==selected&&endpoint(l.target)!==selected;});state.waypoints=state.waypoints.filter(function(x){return x!==selected;});state.anchors=state.anchors.map(function(x){return x===selected?null:x;});}
        if(action==='new'){role('matches').replaceChildren();role('point').value='';role('rationale').value='';history=[];role('saved').replaceChildren();state={id:id(),revision:0,title:'Untitled investigation',nodes:[],links:[],anchors:[],waypoints:[],filters:{hops:3,direction:'undirected',avoid:[]},generation:null,paths:[]};offsets={};selected=null;role('receipt').textContent='New draft';}
        draw();status('Draft updated.');
      });
    });
    el.addEventListener('input',userIntent);
    el.addEventListener('change',function(event){if(event.target.matches('input,select')){userIntent();editEpoch++;}});
    role('title').addEventListener('input',function(){state.title=role('title').value;});
    function attach(host,focus){
      host.appendChild(el);
      if(!started){
        started=true;lastFocus=focus;draw();
        run(async function(){
          var capabilities;
          try{capabilities=await rpc('status');}
          catch(error){legacyMode=true;role('overview-status').textContent='Advanced workspace unavailable. Update the server to enable automatic overview.';if(focus)return expandLegacy(focus);return;}
          if((capabilities.capabilities||[]).includes('graph_overview')){
            var epoch=editEpoch;
            role('overview-status').textContent='Loading your knowledge…';
            try{
              var overview=await rpc('graph_overview',{focus:focus||null});
              if(epoch!==editEpoch)return;
              state.nodes=overview.nodes;state.links=overview.links;state.generation=overview.generation;state.focus=overview.focus;
              draw();role('overview-status').textContent=state.nodes.length?'Overview · '+state.nodes.length+' people and ideas. Click a point to inspect it.':'No indexed points yet. Open Knowledge setup to add documents.';
            }catch(error){role('overview-status').textContent='Could not load the overview: '+error.message;throw error;}
          }else if(focus)await expand(focus);
          else role('overview-status').textContent='Update the server to preload your graph. Advanced investigation remains available.';
        });
      }else if(focus&&focus!==lastFocus){
        if(busy){queuedFocus=focus;return;}
        lastFocus=focus;selectedChanged(focus);run(function(){return expand(focus);});
      }
    }
    return {attach:attach,showMatches:showMatches,snapshot:snapshot,
      questionToken:function(){return {id:state.id,epoch:editEpoch};},
      applyQuestion:function(result,token){
        if(!token||token.id!==state.id||token.epoch!==editEpoch||busy)return false;
        if(!Array.isArray(result.nodes)||!Array.isArray(result.links))return false;
        var canvas=mergeCanvas({nodes:[],links:[]},result);remember();
        state.nodes=canvas.nodes;state.links=canvas.links;state.anchors=result.anchors||[];state.waypoints=result.waypoints||[];state.filters=result.filters||{hops:3,direction:'undirected',avoid:[]};state.generation=result.generation;state.paths=result.paths||[];state.focus=state.anchors[0];state.positions={};offsets={};selected=null;
        role('overview-status').textContent=result.message||'Question investigation';draw();return true;
      }};
  }
  window.COSMemoryWorkspace={create:create,mergeCanvas:mergeCanvas,limits:{nodes:MAX_NODES,edges:MAX_EDGES}};
})();
