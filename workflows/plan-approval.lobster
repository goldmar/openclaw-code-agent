name: plan-approval
args:
  session_id:
    required: true
  session_name:
    required: true
  plan_summary:
    required: true
steps:
  - id: approve
    approval: required

  - id: proceed
    command: openclaw.invoke --tool agent_respond --args-json '{"session":"$session_id","message":"Approved. Go ahead.","approve":true}'
    condition: $approve.approved
