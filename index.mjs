import Twitter from 'twitter-lite';
import dotenv from 'dotenv'
import fetch from 'node-fetch';
import { createClient } from '@supabase/supabase-js'


dotenv.config();

const twitterClient = new Twitter({
    consumer_key: process.env.TWITTER_CONSUMER_KEY,
    consumer_secret: process.env.TWITTER_CONSUMER_SECRET,
    access_token_key: process.env.TWITTER_ACCESS_TOKEN_KEY,
    access_token_secret: process.env.TWITTER_ACCESS_TOKEN_SECRET
});

const supabaseClient = createClient(process.env.SUPABASE_APIURL, process.env.SUPABASE_APISecret);

let userID;

twitterClient.get("account/verify_credentials").then(response => {
    console.log(`Successfully signed in with ${response.name}`);
    userID = response.id;

    //Create a filtered stream that search for keywords
    twitterClient.stream("statuses/filter", {
        track: "udemy com couponCode"
    }).on("start", ()=> {
        console.log("Started tracking tweets");
    }).on("data", filteredTweetStream);
}).catch(error => {
    console.log("Incorrect credentials");
})



function filteredTweetStream(tweet)
{
    if (tweet.user.id != userID)
    {
        tweet.entities.urls.forEach(async (url) => {
            let expandedUrl = url.expanded_url;

            if (isUdemyURL(expandedUrl))
            {
                //Remove tracker and ensure consistency between URL written to database
                const udemySanitizedURL = sanitizeUdemyURL(expandedUrl);

                let existInDatabase = await doesUdemyURLExists(udemySanitizedURL);
                if (!existInDatabase)
                {
                    let courseID = await extractCourseID(expandedUrl);
                    let couponCode = extractCouponCode(expandedUrl);
                    let courseDetails = await getCourseDetails(courseID, couponCode);

                    let courseOriginalPrice = courseDetails.price_text.data.pricing_result.list_price.amount;
                    let courseDiscountedPercent = courseDetails.price_text.data.pricing_result.discount_percent;

                    //This 2 combination ensures that the course is paid and is fully discounted
                    if (courseOriginalPrice != 0 && (courseDiscountedPercent == 100))
                    {
                        let courseTitle = courseDetails.slider_menu.data.title;
                        let courseDiscountExpirationTime = new Date(courseDetails.price_text.data.pricing_result.campaign.end_time).toISOString();
                        let courseDiscountUseRemaining = courseDetails.price_text.data.pricing_result.campaign.uses_remaining;
                        let courseDiscountMaxUse = courseDetails.price_text.data.pricing_result.campaign.maximum_uses;
                        let courseImageHeader = courseDetails.sidebar_container.componentProps.introductionAsset.preview_image_url;

                        tweetStatus(`Title: ${courseTitle}\nAvailability: ${courseDiscountUseRemaining}/${courseDiscountMaxUse}\nOriginal Price: ${courseOriginalPrice}\n${udemySanitizedURL}`);
                        insertUdemyContent(courseTitle, courseDiscountExpirationTime, udemySanitizedURL, courseImageHeader);
                    }
                }
            }
        });
    }
}

async function insertUdemyContent(title, expirationtime, url, imageheader)
{
    const {data, error} = await supabaseClient.from("Udemy").insert([{
        "title": title,
        "expirationTime": expirationtime,
        "udemyUrl": url,
        "imageHeader": imageheader,
    }]);
    if (error)
    {
        console.log("Failed to insert to database");
        console.log(error);
    }
    console.log("Successfully inserted into database");
}

function isUdemyURL(url)
{
    if (new URL(url).hostname == "www.udemy.com")
    {
        return true;
    }
    return false;
}

function sanitizeUdemyURL(url)
{
    let currentURL = new URL(url);
    let newURL = new URL(url);

    currentURL.searchParams.forEach((value, key) => {
        if (key != "couponCode")
        {
            newURL.searchParams.delete(key);
        }
    });
    return newURL.href;
}

async function extractCourseID(url)
{
    let response = await fetch(url);
    let body = await response.text();
    //Extraction using regex
    let responseBody = body.match(/data-clp-course-id="(\d+)"/);
    return responseBody[1];
}

function extractCouponCode(url)
{
    let urlObj = new URL(url);
    return urlObj.searchParams.get("couponCode");
}

async function getCourseDetails(courseID, couponCode)
{
    const finalUrl = `https://www.udemy.com/api-2.0/course-landing-components/${courseID}/me/?couponCode=${couponCode}&components=slider_menu,price_text,sidebar_container`
    let response = await fetch(finalUrl);
    let data = await response.json();
    return data;
}

async function doesUdemyURLExists(url)
{
    const {data, error} = await supabaseClient.from("Udemy").select().eq('udemyUrl', url);
    if (!error)
    {
        if (data.length == 0)
        {
            return false;
        }
        return true;
    }
    return false;
}

async function tweetStatus(content)
{
    try
    {
        const tweet = await twitterClient.post("statuses/update", {
            status: content
        });
        console.log(`Tweet posted at ${tweet.created_at}`);
        console.log(`Tweet content: ${tweet.text}`);
    }
    catch (exception)
    {
        if ('errors' in exception) 
        {
            if (e.errors[0].code === 403)
            {
                console.log("Duplicated post or is currently rate-limited");
            }
        }
    }
}
