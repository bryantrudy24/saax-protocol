insert into saax_router.agents (agent_id, name, description, services, supported_trust, active, owner, token_uri, block_number, last_indexed) values
(
  73249,
  'vitalik_eth.agent',
  'vitalik_eth.agent on Termix Platform',
  '[{"name":"A2A","endpoint":"https://platform-backend-base.prod.termix.live/api/v1/a2a/agents/{agentId}/card","version":"0.3.0"},{"name":"Termix Platform","endpoint":"https://platform-backend-base.prod.termix.live/api/v1/agents/{agentId}/services","version":"aacp-platform-v1"}]'::jsonb,
  '["termix-platform"]'::jsonb,
  true,
  '0xd95fb8d5043db98398b7a782ee33f76ae6066f8a',
  'https://termix-platform-prod.s3.ap-southeast-1.amazonaws.com/platform/agents/0d2615cc26fd4169b2fb6145174e21ec1b17ec1dd8f1100aa7cf070c8cc073ae.json',
  50547444,
  '2026-10-01T19:47:28.458Z'
),
(
  73250,
  'based.agent',
  'based.agent on Termix Platform',
  '[{"name":"A2A","endpoint":"https://platform-backend-base.prod.termix.live/api/v1/a2a/agents/{agentId}/card","version":"0.3.0"},{"name":"Termix Platform","endpoint":"https://platform-backend-base.prod.termix.live/api/v1/agents/{agentId}/services","version":"aacp-platform-v1"}]'::jsonb,
  '["termix-platform"]'::jsonb,
  true,
  '0xd95fb8d5043db98398b7a782ee33f76ae6066f8a',
  'https://termix-platform-prod.s3.ap-southeast-1.amazonaws.com/platform/agents/71e8acbbe44949bdcb53e07aec50b867d66be06ac82a84150e243b3a836fa32b.json',
  50547474,
  '2026-10-01T19:47:28.451Z'
),
(
  73251,
  'ash.agent',
  'ash.agent on Termix Platform',
  '[{"name":"A2A","endpoint":"https://platform-backend-base.prod.termix.live/api/v1/a2a/agents/{agentId}/card","version":"0.3.0"},{"name":"Termix Platform","endpoint":"https://platform-backend-base.prod.termix.live/api/v1/agents/{agentId}/services","version":"aacp-platform-v1"}]'::jsonb,
  '["termix-platform"]'::jsonb,
  true,
  '0xd95fb8d5043db98398b7a782ee33f76ae6066f8a',
  'https://termix-platform-prod.s3.ap-southeast-1.amazonaws.com/platform/agents/7d47344db83289d9a7e93e315d53b81e85f53ade07d3e9f19b50ba97a2cba3fd.json',
  50547490,
  '2026-10-01T19:47:28.455Z'
)
on conflict (agent_id) do update set name=excluded.name, description=excluded.description, services=excluded.services, supported_trust=excluded.supported_trust, active=excluded.active, owner=excluded.owner, token_uri=excluded.token_uri, block_number=excluded.block_number, last_indexed=excluded.last_indexed;