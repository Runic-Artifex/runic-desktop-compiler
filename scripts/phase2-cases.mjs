// Shared actions describe test scenarios, not a framework implementation.
export const editingCases=[
 {name:'typing-selection-deletion',actions:[{kind:'focus'},{kind:'text',value:'abc'},{kind:'select',start:1,end:3},{kind:'text',value:'é'},{kind:'backspace'},{kind:'text',value:'xy'},{kind:'select',start:1,end:1},{kind:'delete'}]},
 {name:'unicode-identity-clear',actions:[{kind:'focus'},{kind:'text',value:'😀e\u0301日本語<&"'},{kind:'select',start:0,end:2},{kind:'text',value:'é'},{kind:'click',id:'toggle'},{kind:'focus'},{kind:'select',start:1,end:3},{kind:'click',id:'clear'},{kind:'focus'}]},
 {name:'readonly-disabled',actions:[{kind:'focus'},{kind:'text',value:'initial'},{kind:'click',id:'readonly'},{kind:'focus'},{kind:'text',value:'rejected'},{kind:'backspace'},{kind:'select',start:0,end:3},{kind:'click',id:'readonly'},{kind:'focus'},{kind:'text',value:'ok'},{kind:'click',id:'lock'},{kind:'focus'},{kind:'click',id:'clear'},{kind:'click',id:'lock'},{kind:'focus'},{kind:'text',value:'enabled'}]},
 {name:'length-limit-caret',actions:[{kind:'focus'},{kind:'payload',value:'a'.repeat(256)},{kind:'select',start:100,end:100},{kind:'text',value:'x'},{kind:'select',start:100,end:101},{kind:'text',value:'é'}]},
 ...['','é','😀','e\u0301','日本語','<&"','a'.repeat(255),'a'.repeat(256),'😀'.repeat(128)].map((value,i)=>({name:'payload-'+i,actions:[{kind:'focus'},{kind:'payload',value},{kind:'click',id:'toggle'},{kind:'click',id:'clear'}]})),
];
export const nativeComposition=[{kind:'focus'},{kind:'ime-preedit',value:'あ'},{kind:'ime-preedit',value:''},{kind:'ime-commit',value:'あ'}];
