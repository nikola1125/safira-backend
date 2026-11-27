#!/usr/bin/env node

require('dotenv').config();
const { S3Client, ListBucketsCommand, ListObjectsV2Command } = require('@aws-sdk/client-s3');

const r2Client = new S3Client({
    region: 'auto',
    endpoint: `https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`,
    credentials: {
        accessKeyId: process.env.R2_ACCESS_KEY_ID,
        secretAccessKey: process.env.R2_SECRET_ACCESS_KEY
    }
});

async function testConnection() {
    console.log('🔍 Testing R2 Connection...\n');
    console.log(`Account ID: ${process.env.R2_ACCOUNT_ID}`);
    console.log(`Endpoint: https://${process.env.R2_ACCOUNT_ID}.r2.cloudflarestorage.com`);
    console.log(`Bucket: ${process.env.R2_BUCKET_NAME}\n`);
    
    // Test 1: List buckets
    try {
        console.log('Test 1: Listing buckets...');
        const listBuckets = new ListBucketsCommand({});
        const bucketsResult = await r2Client.send(listBuckets);
        console.log('✅ Buckets found:', bucketsResult.Buckets?.map(b => b.Name).join(', ') || 'none');
        
        const bucketExists = bucketsResult.Buckets?.some(b => b.Name === process.env.R2_BUCKET_NAME);
        if (bucketExists) {
            console.log(`✅ Bucket "${process.env.R2_BUCKET_NAME}" exists`);
        } else {
            console.log(`❌ Bucket "${process.env.R2_BUCKET_NAME}" NOT FOUND!`);
            console.log('   Available buckets:', bucketsResult.Buckets?.map(b => b.Name).join(', '));
        }
    } catch (error) {
        console.error('❌ Failed to list buckets:');
        console.error('   Error:', error.name);
        console.error('   Message:', error.message);
        console.error('   Code:', error.Code);
    }
    
    // Test 2: List objects in bucket
    try {
        console.log('\nTest 2: Listing objects in bucket...');
        const listObjects = new ListObjectsV2Command({
            Bucket: process.env.R2_BUCKET_NAME,
            MaxKeys: 10
        });
        const objectsResult = await r2Client.send(listObjects);
        console.log(`✅ Found ${objectsResult.KeyCount} objects in bucket`);
        if (objectsResult.Contents && objectsResult.Contents.length > 0) {
            console.log('   Sample objects:');
            objectsResult.Contents.slice(0, 5).forEach(obj => {
                console.log(`   - ${obj.Key}`);
            });
        }
    } catch (error) {
        console.error('❌ Failed to list objects:');
        console.error('   Error:', error.name);
        console.error('   Message:', error.message);
        console.error('   Code:', error.Code);
    }
}

testConnection().catch(console.error);
