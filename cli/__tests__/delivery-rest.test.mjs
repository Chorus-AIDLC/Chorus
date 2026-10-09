import { afterEach, describe, expect, it, vi } from "vitest";
import { createDaemonRestClient } from "../daemon-rest-client.mjs";

function client(fetchImpl, logger = {info(){},warn(){},error(){}}) {
  return createDaemonRestClient({url:"https://example.invalid",apiKey:"private-key",getConnectionUuid:()=>"connection",fetchImpl,logger});
}

afterEach(() => vi.useRealTimers());

describe("exact delivery REST contract", () => {
  it("forwards stable exact admission identity without modifying members", async () => {
    const fetchImpl=vi.fn(async()=>({ok:true,status:200,json:async()=>({data:{turn:{uuid:"primary"}}})}));
    const result=await client(fetchImpl).turnAdvance({sessionId:"session",turnUuid:"primary",turnUuids:["primary","member"],admissionUuid:"token",wakeRecoveryProtocol:1,status:"running"});
    expect(result).toMatchObject({ok:true,data:{turnUuid:"primary"}});
    expect(JSON.parse(fetchImpl.mock.calls[0][1].body)).toMatchObject({turnUuid:"primary",turnUuids:["primary","member"],admissionUuid:"token",wakeRecoveryProtocol:1});
  });

  it.each([undefined,{data:{turn:{uuid:"unrelated"}}}])("never confirms uncorrelated exact admission", async body => {
    const result=await client(async()=>({ok:true,status:200,json:async()=>body})).turnAdvance({sessionId:"session",turnUuid:"primary",turnUuids:["primary"],admissionUuid:"token",wakeRecoveryProtocol:1,status:"running"});
    expect(result).toMatchObject({ok:false,retryable:true});
  });

  it.each([[429,true],[500,true],[403,false],[404,false]])("classifies pending HTTP %s without hot-looping permanent errors", async(status,retryable)=>{
    const result=await client(async()=>({ok:false,status})).readPendingTurns();
    expect(result).toMatchObject({ok:false,status,retryable});
  });

  it("bounds response-body reads as well as connection establishment", async()=>{
    vi.useFakeTimers();
    const request=client(async()=>({ok:true,status:200,json:()=>new Promise(()=>{})})).readPendingTurns();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(await request).toMatchObject({ok:false,status:null,retryable:true,error:expect.stringContaining("TimeoutError")});
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cancels exact admission and exposes safe reset codes", async()=>{
    const warnings=[];
    const reporter=client(async()=>{throw new TypeError("Authorization: private-key",{cause:{code:"ECONNRESET"}});},{info(){},warn:message=>warnings.push(message),error(){}});
    const result=await reporter.turnAdvance({sessionId:"session",turnUuid:"primary",wakeRecoveryProtocol:1,status:"running"});
    expect(result).toMatchObject({ok:false,retryable:true});
    expect(warnings.join(" ")).toContain("ECONNRESET");
    expect(warnings.join(" ")).not.toContain("private-key");
    const controller=new AbortController();
    controller.abort();
    const fetchImpl=vi.fn();
    const aborted=await client(fetchImpl).readPendingTurns({signal:controller.signal});
    expect(aborted).toMatchObject({ok:false,retryable:false});
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});
