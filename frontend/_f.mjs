import { chromium } from 'playwright-core'
const exe='/opt/pw-browsers/chromium-1194/chrome-linux/chrome'
const OUT=process.env.SHOT
const today=new Date().toISOString().slice(0,10)
const d=(n)=>new Date(Date.now()+n*864e5).toISOString().slice(0,10)
const todayJobs=Array.from({length:5},(_,i)=>({id:100+i,status:'scheduled',cleaner_ids:[1],scheduled_date:today,job_type:'standard',title:`Clean #${100+i}`,property_name:'12 Elm St',start_time:'08:00'}))
const weekJobs=[...Array.from({length:16},(_,i)=>({id:200+i,status:'scheduled',cleaner_ids:[(i%2)+1],scheduled_date:d(i%6),job_type:'standard'})),{id:300,status:'scheduled',cleaner_ids:[],scheduled_date:d(1),job_type:'str_turnover'}]
const invoices=[{id:3,status:'overdue',total:45000,due_date:d(-40),client_name:'Acme LLC'}]
const requests=[
 {id:1,name:'Jane Doe',status:'new',service_type:'residential',source:'website',address:'10 Oak St',created_at:today,preview:'Need weekly cleaning'},
 {id:2,name:'Bob Kar',status:'new',service_type:'commercial',source:'website',address:'44 Main St',created_at:today,preview:'Office cleaning quote'},
]
const routes=[
 [/\/api\/comms\/conversations\/summary/,{open:12,resolved:40,breached:2,unassigned:1,unread:4,by_channel:{}}],
 [/\/api\/comms\/conversations\?sla_state=breached/,{items:[{id:'c1',contact_name:'Sarah P.',preview:'Thu?'}]}],
 [/\/api\/comms\/conversations\?assignee=unassigned/,{items:[{id:'c3',contact_name:'New inquiry',preview:'Hi'}]}],
 [/\/api\/jobs\?date=[^&]+$/,todayJobs],[/\/api\/jobs/,weekJobs],
 [/\/api\/invoices\?limit/,invoices],[/\/api\/invoices\/summary/,{by_service:[]}],
 [/\/api\/quotes\/follow-ups/,[{id:'q1'}]],[/\/api\/dispatch\/employees/,[{id:1,name:'Jess'}]],
 [/\/api\/dashboard\/summary/,{new_leads:3,active_clients:64,quotes:{pipeline_value:840000,awaiting:4,changes:1,to_schedule:2,quoted:6,accepted:2,won:5}}],
 [/\/api\/(requests|intake|leads)/,requests],
 [/\/api\//,[]],
]
const stub=async(p)=>{await p.route('**/api/**',(r)=>{const u=r.request().url();for(const[re,b]of routes)if(re.test(u))return r.fulfill({status:200,contentType:'application/json',body:JSON.stringify(b)});return r.fulfill({status:200,contentType:'application/json',body:'[]'})})}
const b=await chromium.launch({executablePath:exe,args:['--no-sandbox']})
const p=await b.newPage({viewport:{width:1440,height:1000}});await stub(p)
await p.goto('http://localhost:4173/login',{waitUntil:'domcontentloaded'})
await p.evaluate(()=>{localStorage.setItem('brightbase_jwt','x');localStorage.setItem('brightbase_user',JSON.stringify({email:'msmall2691@gmail.com',role:'admin',status:'active'}))})
await p.goto('http://localhost:4173/dashboard',{waitUntil:'domcontentloaded'});await p.waitForTimeout(2200)
await p.screenshot({path:OUT+'/final-dash.png'})
await p.goto('http://localhost:4173/requests',{waitUntil:'domcontentloaded'});await p.waitForTimeout(1800)
await p.screenshot({path:OUT+'/final-requests.png'})
console.log('done');await b.close()
