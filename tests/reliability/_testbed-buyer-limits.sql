-- Gate D Phase D prototype: per-buyer daily transaction limits.
-- ISOLATED TESTBED ONLY. Not applied to production. No threshold is chosen here;
-- the caps are parameters so the owner sets them.
CREATE TABLE IF NOT EXISTS ax_router.buyer_daily_spend (
  buyer        text        NOT NULL,
  day          date        NOT NULL,
  spent_units  numeric     NOT NULL DEFAULT 0,
  tx_count     integer     NOT NULL DEFAULT 0,
  updated_at   timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (buyer, day)
);

CREATE OR REPLACE FUNCTION ax_router.reserve_buyer_spend(
  p_buyer text, p_units numeric, p_max_units numeric, p_max_tx integer
) RETURNS jsonb
LANGUAGE plpgsql SECURITY DEFINER
SET search_path = ax_router, public
AS $$
DECLARE v_row ax_router.buyer_daily_spend%ROWTYPE;
BEGIN
  PERFORM pg_advisory_xact_lock(('x'||substr(md5(p_buyer||current_date::text),1,16))::bit(64)::bigint);
  SELECT * INTO v_row FROM ax_router.buyer_daily_spend
   WHERE buyer=p_buyer AND day=current_date;
  IF v_row.buyer IS NULL THEN
    INSERT INTO ax_router.buyer_daily_spend(buyer,day,spent_units,tx_count)
    VALUES (p_buyer,current_date,p_units,1);
    RETURN jsonb_build_object('allowed',true,'spent',p_units,'tx',1);
  END IF;
  IF v_row.spent_units + p_units > p_max_units THEN
    RETURN jsonb_build_object('allowed',false,'reason','daily_amount_cap',
      'spent',v_row.spent_units,'cap',p_max_units);
  END IF;
  IF v_row.tx_count + 1 > p_max_tx THEN
    RETURN jsonb_build_object('allowed',false,'reason','daily_tx_cap',
      'tx',v_row.tx_count,'cap',p_max_tx);
  END IF;
  UPDATE ax_router.buyer_daily_spend
     SET spent_units = spent_units + p_units,
         tx_count    = tx_count + 1,
         updated_at  = now()
   WHERE buyer=p_buyer AND day=current_date;
  RETURN jsonb_build_object('allowed',true,'spent',v_row.spent_units+p_units,'tx',v_row.tx_count+1);
END; $$;

REVOKE ALL ON FUNCTION ax_router.reserve_buyer_spend(text,numeric,numeric,integer) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION ax_router.reserve_buyer_spend(text,numeric,numeric,integer) TO service_role;
