import type { Message } from "../../../Message.ts"

/**
 * Messages Firehose's Kinesis source hands the stream it feeds. The stream tells them from Direct PUT calls by identity:
 * they aren't held to the Direct PUT quotas, they are buffered per source shard, and once a stream has had one it reads
 * a Kinesis stream and refuses PutRecord, as AWS does. Weakly held, so nothing outlives the message.
 */
export const fromKinesis = new WeakSet<Message>()
