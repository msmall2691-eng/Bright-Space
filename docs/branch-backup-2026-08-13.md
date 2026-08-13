# Remote branch tip backup — 2026-08-13 (pre-cleanup)

Escape hatch for the Aug 2026 branch cleanup: a deleted remote branch can be
restored for as long as its tip SHA is known:

    git branch <name> <sha> && git push origin <name>

```
2026-04-05 9d1da75777ddf1f549e569a8d7b532c99bf89aa5 origin/claude/mobile-friendly-update-NBOXN
2026-04-06 153b6ec400b5afd40fb170aede4d743a7ee3423f origin/claude/maineclean-request-pipeline-5ro3C
2026-04-06 2ad0e80e33e4f9f31bcdce78455bf17fe4856b44 origin/claude/debug-inbound-sms-7E6Rs
2026-04-06 a3c10971fb34c3688f1d4b849ca00e16bf2f6c88 origin/claude/add-cleaning-scheduler-MReV6
2026-04-06 eaab5f4f6e25e3809466521858da49995da3259f origin/claude/test-maineclean-workflow-c72ar
2026-04-06 f81d3e5b06973b1a4acb57c3e93a09d29a41b280 origin/claude/website-quote-pipeline-C3JBm
2026-04-07 0e78aec5978363b806e4d034865d54925d0f310a origin/claude/audit-scheduling-system-aFhdK
2026-04-07 8878757f1705a55fcaa0beee3d72bdae6ea4fa83 origin/claude/agents-ui-improvements-9JGB9
2026-04-07 d8dc854dddfca61ebd73abe7f80f0875bb4b35d1 origin/claude/audit-scheduling-system-QjNVx
2026-04-07 e7653f45d1186bf133ffd0f876c1b0945a5a06e1 origin/claude/fix-dashboard-nav-sms-zWwAH
2026-04-15 5e3c7493b76b01a753b35ec09eac102d1eae8f77 origin/claude/add-assigned-to-column-qaUWF
2026-04-15 7fd89c4a3f7c593b16f40309670aea228f7a2405 origin/codex/audit-schema-and-workflows-for-crm
2026-04-15 8054948fd3f3554e25ae30c3c4d7ac000a2d7d46 origin/feat/omnichannel-inbox-phase1
2026-04-15 8b7df00cad8b91c9cd0098ab2258f427f27e7ff6 origin/feat/phase1-hotfix
2026-04-15 8f389deeb0ceec0b0adca6282759bda3d4eecdd7 origin/codex/audit-schema-and-workflows-for-crm-bl1qzb
2026-04-16 dd9c0ce827e6f3d4017635a20d9f9094c6d0b956 origin/claude/restore-comms-location-Hqqoh
2026-04-18 fbd287e7185a359ddd63bb20d30deecd55c1cb62 origin/claude/light-theme-migration-Ln1Ev
2026-04-19 e8d517873db34bc4548bbb1869aeaf6d19fdd391 origin/claude/client-contact-management-jEl5L
2026-04-20 78018db984ef333e1a2fbb1bced73e0b4cc3f86b origin/claude/rentals-auto-sync
2026-04-20 fc18cb748ba3118db738e6210d3316d48191cff6 origin/claude/clientprofile-redesign
2026-04-21 1f3459eceaa2631aca09230d60fe345e3d36a54d origin/feat/user-auth
2026-04-21 6b3c97cfabe599feb40d9eacbfdef8efc2840137 origin/claude/client-properties-jobs-H4tcc
2026-04-21 fc18a97255137d0384c82b34ca5e82167594578f origin/claude/verify-client-profile-mYdUO
2026-04-23 71749aedc2a4b7aa4ef786c9155e1a47ec462050 origin/claude/debug-container-startup-miHwR
2026-04-29 1ab9ee3def9b5e78ca1d1f05dd66933770e86938 origin/feat/scheduler-week-view
2026-04-29 55077b54081491f7b2dd3da5eb13a9fbff88eceb origin/feat/client-timeline-ui
2026-04-29 6febbca26504e272b0d29cc44060004799d5d6f8 origin/feat/activity-auto-log
2026-04-29 e6ccfc9a3cf1ec7b9a34d0af91853ecc301a05c0 origin/feat/visit-pre-materialization
2026-04-29 f6bb62cc92584864b4b93e066b3c77551b4fbdf4 origin/claude/debug-app-crashes-4pi5Q
2026-05-04 d9af24031061328ef71bba0f7a22f6e7ff9cf85e origin/claude/update-audit-brief-Hpd0P
2026-05-05 44c945daf045a2a57f886579979b12337a92347a origin/claude/code-kickoff-pr1-FTOAl
2026-05-05 aa3336c97254bd071bf8f7d43321c88020013bcc origin/claude/stop-ical-sync-OE4p6
2026-06-04 3fa000023c812e5e08fab7f12618937cd2f2c51d origin/claude/backfill-terminal-source
2026-06-05 72dc34d90f35ee8d8544a4b97ffd3161c68edb41 origin/claude/messaging-killswitch
2026-06-05 ae0c958f3ac1227203d4181b34ce50c651ee9315 origin/claude/gcal-account-diagnostic
2026-06-05 f1f41548539b4abc32117721055f9ca343f290da origin/claude/google-signin-spec
2026-06-07 3b241e6b4ebb8b8d628bbcc3cc9dfb54632f0201 origin/claude/fix-quote-send
2026-06-07 956dcd05b78d63ee5384c9bc770ff6407c409aa7 origin/claude/turnover-coverage-hardening
2026-06-19 b79a7ae71af0fa7f859b912580b37b60c0d4b732 origin/claude/phase1-review-queue
2026-07-06 059b6218d568569395b289cca4f7237afb0b35c0 origin/claude/email-greeting-company-detect
2026-07-06 4972746e69fd07d1c394ffe845b1208d40586c5a origin/claude/sms-phone-validation
2026-07-06 a346648344fea6ba6ea7204f1a017f1c70df7566 origin/claude/unit-price-focus-select
2026-07-06 bf1cce67ad871f93c19dde5242329a5d8625ef16 origin/claude/quote-title-customer-facing
2026-07-06 f801a621427b28facc9e2527c578d49589ea00a6 origin/claude/quirky-feynman-wq955a
2026-07-06 fda3f8e74d77ac57ebd1c84c675d6fcc90e657ea origin/claude/convert-to-job-schedule-modal
2026-07-07 fd16db12520ad28c9e9f78d358cb5f133a51e976 origin/claude/lucid-dirac-ypkkjf
2026-07-08 ac85d8aafa0c2603dabd1b9d921fcba2326a3baf origin/claude/schedule-redesign
2026-07-12 c1601e6b6cfc746da64dd88fabc6f23dc62d11e9 origin/claude/connecteam-jobs-mapping-59hs2i
2026-07-14 26ff8c4acc90ba41bb5078e9438baba1bca12c98 origin/claude/brightbase-e2e-audit-dv5ezt
2026-08-03 73ae7ae8286be7f8a67cc5342c5b3513ab564215 origin/add-twenty-crm-sms-mirror
2026-08-04 26a8d8bb2e3d01d2ea2b72da6269e9125f6e0483 origin/dependabot/npm_and_yarn/frontend/undici-7.29.0
2026-08-11 17769ef10f9acdb2458da66b596e1162dc158259 origin/claude/owner-dashboard-quote-n1-fix
2026-08-11 4f10987f4d11ff9bf3b7b498c26e1f67f4d9de61 origin/dependabot/npm_and_yarn/frontend/postcss-8.5.26
2026-08-11 746d608383eaa7e4bd23acfdb06693ac2be8d649 origin/dependabot/npm_and_yarn/frontend/multi-2181bdc769
2026-08-11 7f4c2dbf6e9a642056282b36b1014dc18244ab5b origin/dependabot/npm_and_yarn/frontend/brace-expansion-2.1.4
2026-08-11 f2bd3749e0b8f0c5167f561c2f5f5ef1287459ad origin/dependabot/npm_and_yarn/frontend/multi-2a7858fa97
2026-08-13 5367251408242a1fe58b203240a8a5510b18e79a origin/claude/company-scheduling-redesign-fcdp1l
2026-08-13 d7b25a46da8dd9806e1d966a8cad6428bff7a849 origin/claude/ios-dashboard-impl-3ydth9
```
