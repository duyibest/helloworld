'use strict';
const $ = id => document.getElementById(id);
const fmt = value => new Intl.NumberFormat('en-US').format(value);
let data, route = 'TOKYO', selectedDate = '';
const routes = () => route === 'TOKYO' ? ['HND', 'NRT'] : ['PVG'];
const text = (tag, value, className) => { const e = document.createElement(tag); e.textContent = value; if (className) e.className = className; return e; };
const dateLabel = value => new Date(value + 'T12:00:00').toLocaleDateString('en-US', {month: 'short', day: 'numeric'});
function groupDays() {
 const groups = new Map();
 for (const day of data.days.filter(d => routes().includes(d.destination))) {
  if (!groups.has(day.date)) groups.set(day.date, []);
  groups.get(day.date).push(day);
 }
 return groups;
}
function dayStatus(days) {
 if (days.some(d => d.status === 'available')) return 'available';
 if (days.every(d => d.status === 'unavailable')) return 'unavailable';
 for (const status of ['blocked', 'error', 'stale', 'excluded']) if (days.some(d => d.status === status)) return status;
 return 'unchecked';
}
function render() {
 const month = $('month').value;
 if (!month || !data) return;
 const [year, m] = month.split('-').map(Number), groups = groupDays();
 const monthDays = [...groups].filter(([date]) => date.startsWith(month));
 const available = monthDays.filter(([,ds]) => dayStatus(ds) === 'available');
 const covered = monthDays.filter(([,ds]) => ds.every(d => ['available', 'unavailable', 'excluded'].includes(d.status)));
 const offers = available.flatMap(([,ds]) => ds.flatMap(d => d.results));
 $('available-count').textContent = data.connected ? available.length : '—';
 $('checked-count').textContent = data.connected ? `${covered.length} / ${monthDays.length}` : '—';
 $('lowest-miles').textContent = offers.length ? fmt(Math.min(...offers.map(i => i.miles))) : '—';
 $('coverage-copy').textContent = route === 'TOKYO' ? 'Both Tokyo airports checked' : 'Whole itinerary searched';
 $('month-title').textContent = new Date(year, m-1, 1).toLocaleDateString('en-US', {month:'long',year:'numeric'});
 $('prev').disabled = month <= data.horizon_start.slice(0,7);
 $('next').disabled = month >= data.horizon_end.slice(0,7);
 $('calendar-caption').textContent = route === 'TOKYO' ? 'SFO → HND / NRT · business class' : 'SFO → Tokyo → PVG · business + business or economy';
 const calendar = $('calendar'); calendar.replaceChildren();
 const offset = (new Date(year,m-1,1).getDay()+6)%7;
 for(let i=0;i<offset;i++) calendar.append(document.createElement('div'));
 const names = {available:'Seats found',unavailable:'No seats',unchecked:'Not checked',stale:'Stale',blocked:'Search blocked',error:'Search error',excluded:'No qualifying result'};
 const daysInMonth = new Date(year,m,0).getDate();
 for(let n=1;n<=daysInMonth;n++) {
  const date = `${month}-${String(n).padStart(2,'0')}`, days = groups.get(date), status = days ? dayStatus(days) : 'outside';
  const button = text('button','','day '+status+(selectedDate===date?' selected':''));
  button.append(text('strong',String(n)));
  const results = days ? days.flatMap(d=>d.results) : [];
  button.append(text('small',results.length ? `${fmt(Math.min(...results.map(r=>r.miles)))} miles` : names[status] || 'Outside window'));
  button.disabled = !days;
  button.setAttribute('aria-label',`${date}: ${names[status] || 'Outside window'}`);
  button.setAttribute('aria-pressed',String(selectedDate===date));
  button.addEventListener('click',()=>{selectedDate=selectedDate===date?'':date;render();});
  calendar.append(button);
 }
 renderResults(monthDays);
}
function renderResults(monthDays) {
 const container = $('results');container.replaceChildren();
 $('clear-date').hidden = !selectedDate;
 $('results-title').textContent = selectedDate ? `Itineraries · ${dateLabel(selectedDate)}` : 'Available itineraries';
 const entries = monthDays.filter(([d])=>!selectedDate || d===selectedDate).flatMap(([date,days])=>days.flatMap(day=>day.results.map(it=>({date,day,it}))));
 $('results-subtitle').textContent = `${entries.length} qualifying itineraries · ${$('passengers').value} traveler(s) · one-way`;
 if(!entries.length){
  const empty=text('div','','empty');empty.append(text('span','↗','empty-icon'));
  let title='No verified seats to display',message='No qualifying seats appear in the selected dates. Check the calendar for coverage, excluded itineraries, stale data, or search errors.';
  if(!data.connected){title='Your calendar is ready. The data source isn’t connected.';message='No live ANA searches have run. Dates marked “Not checked” are unknown—not sold out. Connect an authenticated ANA Mileage Club collector to begin daily updates.';}
  else if(data.state==='error'){title='The latest snapshot could not be loaded';message='Previously observed seats are hidden until the data source recovers. A failed refresh never means that seats have sold out.';}
  else if(!monthDays.some(([,ds])=>ds.some(d=>d.status!=='unchecked'))){title='These dates haven’t been checked';message='The daily collector has not supplied results for these dates. No availability is being inferred.';}
  else if(selectedDate){const ds=monthDays.find(([d])=>d===selectedDate)?.[1]||[];if(ds.length && dayStatus(ds)==='unavailable'){title='No seats at the last completed check';message='The source completed a search for this date with no award itineraries. Availability can change before the next daily refresh.';}}
  empty.append(text('h4',title),text('p',message));container.append(empty);return;
 }
 entries.sort((a,b)=>a.date.localeCompare(b.date)||a.it.miles-b.it.miles);
 for(const {date,day,it} of entries){
  const card=text('article','','flight'),dateBox=text('div',dateLabel(date),'flight-date');
  dateBox.append(text('small',`${it.seats} seat(s) observed`));
  const details=text('div'), path=['SFO',...it.segments.map(s=>s.destination)].join(' → ');
  details.append(text('div',path,'flight-path'));
  const legs=text('div','','flight-legs');
  for(const s of it.segments) legs.append(text('div',`${s.flight} · ${s.operator === 'NH' ? 'ANA-operated' : s.operator} · ${s.cabin} · ${new Date(s.departure).toLocaleString('en-US',{timeZone:s.origin==='SFO'?'America/Los_Angeles':'Asia/Tokyo',month:'short',day:'numeric',hour:'numeric',minute:'2-digit',timeZoneName:'short'})}`));
  legs.append(text('div',`Observed ${new Date(day.checked_at).toLocaleString()} · ANA Mileage Club`));details.append(legs);
  const price=text('div',fmt(it.miles),'flight-price');price.append(text('small','miles / person'),text('small',it.taxes ? `Taxes: ${it.taxes}` : 'Taxes not provided'));
  const link=text('a','Recheck on ANA ↗');link.href='https://www.ana.co.jp/en/jp/guide/amc/award/international/application/';link.target='_blank';link.rel='noopener noreferrer';price.append(link);
  card.append(dateBox,details,price);container.append(card);
 }
}
async function load(){
 $('refresh').disabled=true;
 try {
  const response=await fetch(`/api/availability?passengers=${$('passengers').value}`,{cache:'no-store'});
  if(!response.ok) throw new Error('Availability request failed');
  data=await response.json();
  $('month').min=data.horizon_start.slice(0,7);$('month').max=data.horizon_end.slice(0,7);
  if(!$('month').value)$('month').value=data.horizon_start.slice(0,7);
  $('source-title').textContent=data.state==='error'?'Snapshot unavailable':data.connected?'Snapshot source connected':'ANA data source not connected';
  $('source-copy').textContent=data.state==='error'?'Could not read the latest snapshot. Available seats are hidden until the source recovers.':data.connected?`Source: ${data.source}. Availability is observed, not guaranteed; reconfirm the full itinerary before booking.`:'No automated ANA collector is connected yet. Login, session renewal, and source access must be established before daily searches can run. This page contains no simulated award seats.';
  $('source-tag').textContent=data.connected?'SNAPSHOT LOADED':'SETUP REQUIRED';
  $('freshness').textContent=data.generated_at?`Snapshot: ${new Date(data.generated_at).toLocaleString()}`:'Daily refresh planned · not active';
  render();
 }catch(error){$('source-title').textContent='Unable to load availability';$('source-copy').textContent='The service could not load the calendar. Retry to fetch the latest status.';data=null;$('calendar').replaceChildren();$('results').replaceChildren();for(const id of ['available-count','checked-count','lowest-miles'])$(id).textContent='—';}
 finally{$('refresh').disabled=false;}
}
for(const button of document.querySelectorAll('[data-route]'))button.addEventListener('click',()=>{route=button.dataset.route;selectedDate='';for(const b of document.querySelectorAll('[data-route]'))b.setAttribute('aria-pressed',String(b===button));render();});
$('month').addEventListener('change',()=>{if($('month').value<$('month').min)$('month').value=$('month').min;if($('month').value>$('month').max)$('month').value=$('month').max;selectedDate='';render();});
for(const [id,delta] of [['prev',-1],['next',1]])$(id).addEventListener('click',()=>{const[y,m]=$('month').value.split('-').map(Number);const d=new Date(y,m-1+delta,1);$('month').value=`${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}`;selectedDate='';render();});
$('clear-date').addEventListener('click',()=>{selectedDate='';render();});
$('refresh').addEventListener('click',load);$('passengers').addEventListener('change',()=>{selectedDate='';load();});load();
