-- No customer data is changed by this scheduling migration.
select cron.schedule('muse-expire-stalled-jobs','* * * * *','select private.expire_stalled_muse_jobs();');
