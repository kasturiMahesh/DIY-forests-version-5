const http=require('http'),handler=require('serve-handler');
http.createServer((q,r)=>handler(q,r,{public:process.argv[2]||require('path').resolve(__dirname,'../../..'),cleanUrls:false})).listen(8011,()=>console.log('orig on 8011'));
