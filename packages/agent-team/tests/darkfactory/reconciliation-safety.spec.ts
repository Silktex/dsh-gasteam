import { afterEach, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runGit } from '../../src/git-command.ts'
import { assertGithubRepository, redactProviderText } from '../../src/darkfactory/reconciliation-safety.ts'
const directories: string[] = []
afterEach(async () => { await Promise.all(directories.splice(0).map(path => rm(path,{recursive:true,force:true}))) })
it('binds the registered Git origin without allowing credential-bearing or unrelated URLs',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'factory-origin-'));directories.push(directory)
 const git=(args:string[])=>runGit(directory,args,new AbortController().signal,5000)
 await git(['init','--quiet'])
 await git(['remote','add','origin','https://github.com/example/service.git'])
 await expect(assertGithubRepository(directory,'example/service')).resolves.toBeUndefined()
 await git(['remote','set-url','origin','git@github.com:example/service.git'])
 await expect(assertGithubRepository(directory,'example/service')).resolves.toBeUndefined()
 for(const origin of ['https://secret:password@github.com/example/service.git','https://github.com.evil.invalid/example/service.git','https://github.com/example/other.git','file:///untrusted']){
  await git(['remote','set-url','origin',origin])
  await expect(assertGithubRepository(directory,'example/service')).rejects.toThrow('does not match')
 }
})
it('redacts host credentials and common structured secrets while preserving executable issue prose',()=>{
 const input='Empty requests crash. password=hidden authorization: Bearer hidden2 ghp_abcdefghijklmnopqrstuvwxyz host-key'
 const output=redactProviderText(input,['host-key'])
 expect(output).toContain('Empty requests crash.')
 for(const secret of ['hidden','hidden2','ghp_abcdefghijklmnopqrstuvwxyz','host-key'])expect(output).not.toContain(secret)
})
