import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventRouter } from "../event-router.mjs";
import { createBackfill } from "../backfill.mjs";
import { createDeliveryRecovery } from "../delivery-recovery.mjs";

const notification={uuid:"source",action:"mentioned",entityType:"idea",entityUuid:"idea",message:"original comment"};
const turn={turnUuid:"comment-turn",sessionId:"idea",directIdeaUuid:"idea",trigger:"mentioned",wakeContext:{version:1,notificationUuid:"source",notification}};
const logger={info(){},warn(){},error(){}};

beforeEach(()=>{vi.useFakeTimers();vi.setSystemTime(0);});
afterEach(()=>vi.useRealTimers());

describe("router + pending REST + recovery loop",()=>{
  it("recovers the original failed comment even after notification read, without using the newer chat as its identity",async()=>{
    let failing=true;
    const seen=new Set();
    const queued=[];
    const mcpClient={callTool:vi.fn(async()=>{if(failing)throw new Error("ECONNRESET");return {notifications:[]};})};
    const router=new EventRouter({mcpClient,seen,getConnectionUuid:()=>"connection",wakeActions:new Set(["mentioned","human_instruction"]),logger,
      waker:{keyFor:async()=>({key:"idea:idea",rootIdeaUuid:"idea",directIdeaUuid:"idea"})},queue:{enqueue:(key,item)=>{queued.push(item.notification);return true;}}});
    const backfill=createBackfill({mcpClient,seen,logger,dispatch:event=>router.dispatch(event),dispatchPendingTurn:(pending,options)=>router.dispatchPendingTurn(pending,options),getConnectionUuid:()=>"connection",url:"https://example.invalid",apiKey:"fake",
      fetchImpl:async()=>{if(failing)throw new Error("ECONNRESET");return {ok:true,status:200,json:async()=>({data:{turns:[turn]}})};}});
    const recovery=createDeliveryRecovery({router,backfill,getConnectionUuid:()=>"connection",logger,random:()=>0.5});
    recovery.register();await vi.advanceTimersByTimeAsync(0);
    await recovery.dispatch({type:"new_notification",notificationUuid:"source",targetConnectionUuid:"connection"});
    await recovery.deliver("comment-turn");
    expect(queued).toHaveLength(0);expect(seen.has("source")).toBe(false);
    failing=false;
    await router.dispatchPendingTurn({turnUuid:"chat-turn",sessionId:"idea",directIdeaUuid:"idea",trigger:"human_instruction",promptText:"new chat"});
    await vi.advanceTimersByTimeAsync(1_000);
    expect(queued.map(item=>item.turnUuid)).toEqual(["chat-turn","comment-turn"]);
    expect(queued[1].message).toBe("original comment");
    await Promise.all([recovery.deliver("comment-turn"),recovery.dispatch({type:"new_notification",notificationUuid:"source",turnUuid:turn.turnUuid,wakeContext:turn.wakeContext,targetConnectionUuid:"connection"})]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(queued).toHaveLength(2);
    recovery.stop();
  });

  it("releases all accepted aliases only after cancelled admission gives responsibility back",async()=>{
    const enqueue=vi.fn(()=>true);
    const router=new EventRouter({mcpClient:{callTool:vi.fn()},getConnectionUuid:()=>"connection",wakeActions:new Set(["mentioned"]),logger,
      waker:{keyFor:async()=>({key:"idea:idea",directIdeaUuid:"idea"})},queue:{enqueue}});
    expect(await router.dispatchPendingTurn(turn)).toMatchObject({status:"accepted"});
    router.releaseAccepted([turn.turnUuid]);
    expect(router.seen.has("source")).toBe(false);
    expect(router.seen.has("turn:comment-turn")).toBe(false);
    expect(await router.dispatchPendingTurn(turn)).toMatchObject({status:"accepted"});
    expect(enqueue).toHaveBeenCalledTimes(2);
  });

  it("does not enqueue a lineage result that completes after recovery stops",async()=>{
    let complete;
    const enqueue=vi.fn();
    const router=new EventRouter({mcpClient:{callTool:vi.fn()},getConnectionUuid:()=>"connection",wakeActions:new Set(["mentioned"]),logger,
      waker:{keyFor:()=>new Promise(resolve=>{complete=resolve;})},queue:{enqueue}});
    const recovery=createDeliveryRecovery({router,backfill:{pendingTurnsOnly:async()=>({status:"accepted",outcomes:{}})},getConnectionUuid:()=>"connection",logger});
    recovery.register();await vi.advanceTimersByTimeAsync(0);
    const running=recovery.dispatch({type:"new_notification",notificationUuid:"source",turnUuid:turn.turnUuid,wakeContext:turn.wakeContext,targetConnectionUuid:"connection"});
    await Promise.resolve();
    recovery.stop();
    complete({key:"idea:idea",directIdeaUuid:"idea"});
    await running;await vi.advanceTimersByTimeAsync(60_000);
    expect(enqueue).not.toHaveBeenCalled();expect(router.seen.size).toBe(0);
  });
});
