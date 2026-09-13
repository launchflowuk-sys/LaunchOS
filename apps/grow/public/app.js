const scenarios={services:{label:'FROM ENQUIRY TO JOB',title:'The next job starts<br>before the phone rings.',copy:'A visitor finds the right service, sends their details and becomes a lead your team can actually manage.',steps:[['Your website does the welcoming','Clear services and a focused quote request.'],['Your back office keeps the details','The enquiry arrives with the customer record.'],['Your team takes it forward','Follow up, organise the work and track progress.']]},bookings:{label:'FROM VISITOR TO APPOINTMENT',title:'Fill the diary.<br>Keep the details together.',copy:'Give customers a clear route to book, then keep appointments, customer details and payments connected behind the scenes.',steps:[['Your customer chooses a service','The right information and a clear booking journey.'],['The appointment reaches your diary','Customer records and scheduling in one place.'],['Everyone knows what comes next','Confirmation emails and payment tools, as scoped.']]},orders:{label:'FROM BROWSING TO ORDER',title:'Make ordering easy.<br>Keep your team in the loop.',copy:'A direct ordering experience under your own brand, with the tools your team needs to receive and manage each order.',steps:[['Your customer finds what they want','A clear menu and an easy way to order.'],['Checkout connects to your business','Order details and online payment work together.'],['Your team gets to work','See incoming orders and manage fulfilment.']]}};
const tabs=[...document.querySelectorAll('[role="tab"]')];function selectTab(tab){tabs.forEach(t=>{const active=t===tab;t.setAttribute('aria-selected',String(active));t.tabIndex=active?0:-1});const s=scenarios[tab.dataset.scenario];document.getElementById('workflow').setAttribute('aria-labelledby',tab.id);document.getElementById('scenario-label').textContent=s.label;document.getElementById('scenario-title').innerHTML=s.title;document.getElementById('scenario-copy').textContent=s.copy;document.getElementById('flow-steps').innerHTML=s.steps.map(([title,copy],i)=>`<div class="flow-step"><span>0${i+1}</span><div><strong>${title}</strong><p>${copy}</p></div><b>${i===2?'✓':'↘'}</b></div>`).join('')};tabs.forEach((tab,i)=>{tab.addEventListener('click',()=>selectTab(tab));tab.addEventListener('keydown',e=>{let next;if(e.key==='ArrowRight')next=(i+1)%tabs.length;else if(e.key==='ArrowLeft')next=(i+tabs.length-1)%tabs.length;else if(e.key==='Home')next=0;else if(e.key==='End')next=tabs.length-1;else return;e.preventDefault();selectTab(tabs[next]);tabs[next].focus()})});

// Forward campaign attribution to the existing brief funnel. No cookies or storage.
(() => {
  const campaign = new URLSearchParams(window.location.search);
  const allowed = ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content', 'utm_id', 'fbclid', 'gclid', 'gbraid', 'wbraid', 'msclkid', 'ttclid'];
  document.querySelectorAll('a[href="https://launchflow.co.uk/start"]').forEach(link => {
    const destination = new URL(link.href);
    allowed.forEach(key => {
      const value = campaign.get(key);
      if (value) destination.searchParams.set(key, value);
    });
    link.href = destination.href;
  });
})();
