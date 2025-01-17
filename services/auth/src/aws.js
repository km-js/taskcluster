const builder = require('./api');

builder.declare({
  method: 'get',
  route: '/aws/s3/:level/:bucket/:prefix(*)',
  name: 'awsS3Credentials',
  input: undefined,
  output: 'aws-s3-credentials-response.yml',
  query: {
    format: /iam-role-compat/,
  },
  stability: 'stable',
  category: 'AWS Credentials',
  scopes: {
    if: 'levelIsReadOnly',
    then: {AnyOf: [
      'auth:aws-s3:read-only:<bucket>/<prefix>',
      'auth:aws-s3:read-write:<bucket>/<prefix>',
    ]},
    else: 'auth:aws-s3:read-write:<bucket>/<prefix>',
  },
  title: 'Get Temporary Read/Write Credentials S3',
  description: [
    'Get temporary AWS credentials for `read-write` or `read-only` access to',
    'a given `bucket` and `prefix` within that bucket.',
    'The `level` parameter can be `read-write` or `read-only` and determines',
    'which type of credentials are returned. Please note that the `level`',
    'parameter is required in the scope guarding access.  The bucket name must',
    'not contain `.`, as recommended by Amazon.',
    '',
    'This method can only allow access to a whitelisted set of buckets.  To add',
    'a bucket to that whitelist, contact the Taskcluster team, who will add it to',
    'the appropriate IAM policy.  If the bucket is in a different AWS account, you',
    'will also need to add a bucket policy allowing access from the Taskcluster',
    'account.  That policy should look like this:',
    '',
    '```js',
    '{',
    '  "Version": "2012-10-17",',
    '  "Statement": [',
    '    {',
    '      "Sid": "allow-taskcluster-auth-to-delegate-access",',
    '      "Effect": "Allow",',
    '      "Principal": {',
    '        "AWS": "arn:aws:iam::692406183521:root"',
    '      },',
    '      "Action": [',
    '        "s3:ListBucket",',
    '        "s3:GetObject",',
    '        "s3:PutObject",',
    '        "s3:DeleteObject",',
    '        "s3:GetBucketLocation"',
    '      ],',
    '      "Resource": [',
    '        "arn:aws:s3:::<bucket>",',
    '        "arn:aws:s3:::<bucket>/*"',
    '      ]',
    '    }',
    '  ]',
    '}',
    '```',
    '',
    'The credentials are set to expire after an hour, but this behavior is',
    'subject to change. Hence, you should always read the `expires` property',
    'from the response, if you intend to maintain active credentials in your',
    'application.',
    '',
    'Please note that your `prefix` may not start with slash `/`. Such a prefix',
    'is allowed on S3, but we forbid it here to discourage bad behavior.',
    '',
    'Also note that if your `prefix` doesn\'t end in a slash `/`, the STS',
    'credentials may allow access to unexpected keys, as S3 does not treat',
    'slashes specially.  For example, a prefix of `my-folder` will allow',
    'access to `my-folder/file.txt` as expected, but also to `my-folder.txt`,',
    'which may not be intended.',
    '',
    'Finally, note that the `PutObjectAcl` call is not allowed.  Passing a canned',
    'ACL other than `private` to `PutObject` is treated as a `PutObjectAcl` call, and',
    'will result in an access-denied error from AWS.  This limitation is due to a',
    'security flaw in Amazon S3 which might otherwise allow indefinite access to',
    'uploaded objects.',
    '',
    '**EC2 metadata compatibility**, if the querystring parameter',
    '`?format=iam-role-compat` is given, the response will be compatible',
    'with the JSON exposed by the EC2 metadata service. This aims to ease',
    'compatibility for libraries and tools built to auto-refresh credentials.',
    'For details on the format returned by EC2 metadata service see:',
    '[EC2 User Guide](http://docs.aws.amazon.com/AWSEC2/latest/UserGuide/' +
    'iam-roles-for-amazon-ec2.html#instance-metadata-security-credentials).',
  ].join('\n'),
}, async function(req, res) {
  let level = req.params.level;
  let bucket = req.params.bucket;
  let prefix = req.params.prefix;

  // Validate that a proper value was given for level
  if (level !== 'read-write' && level !== 'read-only') {
    return res.reportError('InputError',
      'the \'level\' URL parameter must be read-only or read-write; got {{levelGiven}}',
      {levelGiven: level});
  }

  // Check that the client is authorized to access given bucket and prefix
  await req.authorize({level, bucket, prefix, levelIsReadOnly: level === 'read-only'});

  // Prevent prefix to start with a slash, this is bad behavior. Technically
  // we could easily support it, S3 does, but people rarely wants double
  // slashes in their URIs intentionally.
  if (prefix[0] === '/') {
    return res.reportError('InputError',
      'The `prefix` may not start with a slash `/`; got `{{prefix}}`',
      {prefix});
  }

  // Decide actions to be allowed on S3 objects
  let objectActions = [
    's3:GetObject',
  ];
  if (level === 'read-write') {
    objectActions.push(
      's3:PutObject',
      's3:DeleteObject',
    );
  }

  // For details on the policy see: http://amzn.to/1ETStaL
  let iamReq = await this.sts.getFederationToken({
    Name: 'TemporaryS3ReadWriteCredentials',
    Policy: JSON.stringify({
      Version: '2012-10-17',
      Statement: [
        {
          Sid: 'ReadWriteObjectsUnderPrefix',
          Effect: 'Allow',
          Action: objectActions,
          Resource: [
            'arn:aws:s3:::{{bucket}}/{{prefix}}*'
              .replace('{{bucket}}', bucket)
              .replace('{{prefix}}', prefix),
          ],
        }, {
          Sid: 'ListObjectsUnderPrefix',
          Effect: 'Allow',
          Action: [
            's3:ListBucket',
          ],
          Resource: [
            'arn:aws:s3:::{{bucket}}'
              .replace('{{bucket}}', bucket),
          ],
          Condition: {
            StringLike: {
              's3:prefix': [
                '{{prefix}}*'.replace('{{prefix}}', prefix),
              ],
            },
          },
        }, {
          Sid: 'GetBucketLocation',
          Effect: 'Allow',
          Action: [
            's3:GetBucketLocation',
          ],
          Resource: [
            'arn:aws:s3:::{{bucket}}'
              .replace('{{bucket}}', bucket),
          ],
        },
      ],
    }),
    DurationSeconds: 60 * 60, // Expire credentials in an hour
  }).promise();

  // Make result compatibility with how EC2 metadata service let's instances
  // access IAM roles
  if (req.query.format === 'iam-role-compat') {
    return res.status(200).json({
      Code: 'Success',
      Type: 'AWS-HMAC',
      LastUpdated: new Date().toJSON(),
      AccessKeyId: iamReq.Credentials.AccessKeyId,
      SecretAccessKey: iamReq.Credentials.SecretAccessKey,
      Token: iamReq.Credentials.SessionToken,
      Expiration: new Date(iamReq.Credentials.Expiration).toJSON(),
    });
  }

  return res.reply({
    credentials: {
      accessKeyId: iamReq.Credentials.AccessKeyId,
      secretAccessKey: iamReq.Credentials.SecretAccessKey,
      sessionToken: iamReq.Credentials.SessionToken,
    },
    expires: new Date(iamReq.Credentials.Expiration).toJSON(),
  });
});
